import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chatTimeoutMs, turnTimeouts, turnDeadlines, deadlines, failureKind, failureText, reconcileDeadTurn, saveReceipt } from "./recovery.ts";
import { Runtime } from "./runtime.ts";
import { State, type Worker } from "./state.ts";
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-recovery-"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://localhost:1", token: "fixture" }));
  const state = new State(join(dir, "state.sqlite"));
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} }, { dataDir: dir, cliPath: "cli", repo: dir, apiUrl: "http://localhost:1" });
  const c = runtime.createConversation("requester", { sokosumi_organization_id: "org" });
  const job = runtime.createResponse("requester", c.id, "Inspect example", "stable");
  const next = runtime.nextJob("old", 1)!;
  const token = JSON.parse(readFileSync(next.jobConfig, "utf8")).token;
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, runtime, job, c, token };
}
const dead = { runnerGone: true, activeState: "inactive", loadState: "not-found" };

test("turn deadlines retain a validated one hour default and classify systemd timeout before JS watchdog", () => {
  assert.equal(chatTimeoutMs(), 3600000);
  assert.deepEqual(deadlines(600000), { runtimeSeconds: 600, stopSeconds: 5, watchdogMs: 610000 });
  assert.equal(deadlines(900000).watchdogMs, 910000);
  for (const bad of [0, 59999, 60001, 3600001, "oops"]) assert.throws(() => chatTimeoutMs(bad));
  assert.equal(failureKind("timeout", 1, false, false, false), "turn_timeout");
  assert.equal(failureKind("oom-kill", 1, false, false, false), "turn_oom_killed");
  assert.equal(failureKind("exit-code", 2, false, false, false), "turn_exit_failure");
  assert.equal(failureKind("success", 0, false, false, true), undefined);
  assert.equal(failureKind("success", 0, false, false, false), "turn_empty_output");
  assert.doesNotMatch(failureText("turn_exit_failure"), /memory|swapping|secret/i);
});

test("process death and nonzero exits remain distinct without assuming resource failure", async () => {
  const failed = spawn(process.execPath, ["-e", "process.exit(7)"]); const [exit] = await once(failed, "close");
  assert.equal(failureKind("exit-code", exit, false, false, false), "turn_exit_failure");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]); child.kill("SIGKILL");
  const [code, signal] = await once(child, "close");
  assert.equal(code, null); assert.equal(signal, "SIGKILL");
  assert.equal(failureKind("signal", 1, false, false, false), "turn_signal");
});

test("dead pre-execution reservation recovers same job with bounded attempts and rotates scope", t => {
  const f = fixture(t);
  assert.equal(f.runtime.nextJob("replacement", 1), null);
  assert.equal(reconcileDeadTurn(f.runtime, f.dir, f.job.id, { ...dead, runnerGone: false }), false);
  assert.equal(reconcileDeadTurn(f.runtime, f.dir, f.job.id, { ...dead, activeState: "active", loadState: "loaded" }), false);
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  const next = f.runtime.nextJob("replacement", 1)!;
  assert.equal(next.job.id, f.job.id); assert.equal(next.job.conversationId, f.c.id);
  assert.equal(f.runtime.authorizeControl(f.token, "projects", { jobId: f.job.id }), false);
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead); f.runtime.nextJob("third", 1);
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  assert.equal(f.runtime.job(f.job.id).error, "recovery_required");
  assert.equal(f.runtime.job(f.job.id).recoveryAttempts, 2);
  assert.equal(f.state.all("jobs").length, 1);
});

test("started or legacy turns never replay automatically and begin-turn lost ack cannot execute twice", async t => {
  const f = fixture(t);
  await f.runtime.control("begin-turn", { jobId: f.job.id, runnerId: "old" });
  await assert.rejects(f.runtime.control("begin-turn", { jobId: f.job.id, runnerId: "old" }));
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  assert.equal(f.runtime.job(f.job.id).error, "recovery_required");
  assert.equal(f.runtime.nextJob("replacement", 1), null);
  assert.equal(f.state.all("outbox").length, 0);
  const legacy = f.runtime.createResponse("requester", f.c.id, "Legacy", "legacy"); f.runtime.nextJob("legacy");
  reconcileDeadTurn(f.runtime, f.dir, legacy.id, dead);
  assert.equal(f.runtime.job(legacy.id).error, "recovery_required");
});

test("durable completion survives bridge restart and lost reply ack without duplicate side effects", t => {
  const f = fixture(t); const path = join(f.dir, `${f.job.id}.0.completion.json`);
  saveReceipt(path, { jobId: f.job.id, attempt: 0, text: "Confirmed final", threadId: "thread-example" });
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  const reopened = new State(join(f.dir, "state.sqlite"));
  assert.equal(reopened.get<{text:string}>("jobs", f.job.id)!.text, "Confirmed final"); reopened.close();
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  f.runtime.completeJob(f.job.id, "Confirmed final");
  assert.equal(f.state.all("jobs").length, 1); assert.equal(f.state.all("outbox").length, 0);
  assert.equal(f.runtime.nextJob("replacement", 1), null);
  assert.equal(f.state.get("threads", f.c.id), "thread-example");
});

test("turn.completed plus output can recover, partial/untrusted output cannot imply success", t => {
  const f = fixture(t); saveReceipt(join(f.dir, `${f.job.id}.0.turn.json`), { jobId: f.job.id, attempt: 0, launched: true, completed: true });
  writeFileSync(join(f.dir, `${f.job.id}.0.txt`), "Final answer");
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead); assert.equal(f.runtime.job(f.job.id).status, "completed");
  const j = f.runtime.createResponse("requester", f.c.id, "Other"); f.runtime.nextJob("runner", 1);
  const current = f.runtime.job(j.id); current.turnStarted = true; f.state.put("jobs", j.id, current);
  writeFileSync(join(f.dir, `${j.id}.0.txt`), "Partial output");
  reconcileDeadTurn(f.runtime, f.dir, j.id, dead); assert.equal(f.runtime.job(j.id).status, "failed");
  assert.doesNotMatch(f.runtime.job(j.id).text, /Partial output/);
});

test("explicit reconciled retry retains identity, blocks uncertain sends and rejects stale completion", async t => {
  const f = fixture(t); f.runtime.completeJob(f.job.id, "Stopped", "turn_timeout");
  const control = f.runtime.createResponse("requester", f.c.id, "User authorized recovery"); f.runtime.nextJob("new", 1);
  const args = { jobId: control.id, responseId: f.job.id, reconciled: true, reconciliation: "Verified prior worker/task and existing PR; no uncertain sends. Continue the same work." };
  f.state.put("outbox", "uncertain", { id: "uncertain", conversationId: f.c.id, status: "uncertain" });
  await assert.rejects(f.runtime.control("recover-chat", args), /Uncertain/);
  f.state.put("outbox", "uncertain", { id: "uncertain", conversationId: f.c.id, status: "sent" });
  await assert.rejects(f.runtime.control("recover-chat", { ...args, reconciled: false }));
  await f.runtime.control("recover-chat", args);
  assert.equal(f.runtime.job(f.job.id).status, "queued");
  await assert.rejects(f.runtime.control("reply", { jobId: f.job.id, attempt: 0, text: "Stale" }), /Stale/);
  assert.equal(f.runtime.createResponse("requester", f.c.id, "Inspect example", "stable").id, f.job.id);
  assert.equal(f.state.all("workers").length, 0);
  assert.equal(f.state.all("outbox").length, 1);
});

test("other conversation and worker scopes cannot recover chats", async t => {
  const f = fixture(t); f.runtime.completeJob(f.job.id, "Stopped", "turn_timeout");
  const other = f.runtime.createConversation("other", { sokosumi_organization_id: "other-org" });
  const j = f.runtime.createResponse("other", other.id, "Other"); f.runtime.nextJob("other", 1);
  await assert.rejects(f.runtime.control("recover-chat", { jobId: j.id, responseId: f.job.id, reconciled: true, reconciliation: "Claim" }));
  const config = f.runtime.scopedConfig({ kind: "worker", id: "worker", generation: 1 });
  f.state.put("workers", "worker", { generation: 1 });
  const token = JSON.parse(readFileSync(config, "utf8")).token;
  assert.equal(f.runtime.authorizeControl(token, "recover-chat", { jobId: j.id }), false);
});

test("missing workers retain uncertain instructions and human approval boundaries", async t => {
  const f = fixture(t);
  const worker = { id: "worker", conversationId: f.c.id, state: "missing", generation: 1, taskId: "task", recoveryHold: true } as Worker;
  f.state.put("workers", worker.id, worker);
  await f.runtime.recoverWorkers();
  assert.equal(f.state.get<Worker>("workers", worker.id)!.state, "recovery_blocked");
  f.state.put("workers", worker.id, { ...worker, recoveryHold: false });
  f.state.put("deliveries", "delivery", { id: "delivery", workerId: worker.id, status: "uncertain", text: "Previously submitted instruction" });
  await f.runtime.recoverWorkers();
  assert.equal(f.state.get<{status:string}>("deliveries", "delivery")!.status, "uncertain");
  assert.equal(f.state.get<Worker>("workers", worker.id)!.state, "recovery_blocked");
});

test("ack loss repeats completion only, never repeats task/chat delivery reservation", async t => {
  const f = fixture(t);
  const job = f.runtime.job(f.job.id); job.kind = "worker"; job.taskId = "existing-task"; f.state.put("jobs", job.id, job);
  const c = f.state.get<{metadata:Record<string,string>}>("conversations", f.c.id)!;
  c.metadata.sokosumi_room_id = "existing-room"; f.state.put("conversations", f.c.id, c);
  const reply = { jobId: job.id, attempt: 0, text: "Existing PR checked and reused." };
  await f.runtime.control("reply", reply); // successful commit, response lost
  const snapshot = JSON.stringify(f.state.all("outbox"));
  await f.runtime.control("reply", reply); // retried acknowledgment
  assert.equal(JSON.stringify(f.state.all("outbox")), snapshot);
  assert.equal(f.state.all("outbox").length, 2); // one task update, one chat delivery
  assert.equal(f.state.all("workers").length, 0);
});

test("corrupt or wrong-generation receipts fail closed without leaking stored text", t => {
  const f = fixture(t);
  saveReceipt(join(f.dir, `${f.job.id}.0.completion.json`), { jobId: f.job.id, attempt: 9, text: "PRIVATE_TEST_PAYLOAD" });
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  assert.equal(f.runtime.job(f.job.id).error, "recovery_required");
  assert.doesNotMatch(f.runtime.job(f.job.id).text, /PRIVATE_TEST_PAYLOAD/);
  const job = f.runtime.createResponse("requester", f.c.id, "Restored older snapshot");
  f.runtime.nextJob("runner", 1);
  saveReceipt(join(f.dir, `${job.id}.0.turn.json`), { jobId: job.id, attempt: 0, launched: true });
  reconcileDeadTurn(f.runtime, f.dir, job.id, dead);
  assert.equal(f.runtime.job(job.id).status, "failed", "newer launch evidence overrides an older unstarted DB snapshot");
});

test("recovering the same chat reuses its existing task/worker operation instead of creating external work", async t => {
  const f = fixture(t);
  const existing = { id: "existing-worker", taskId: "existing-task", conversationId: f.c.id, branch: "feature/example", worktree: "/synthetic/worktree", result: "Existing PR: https://example.invalid/pull/1" } as Worker;
  f.state.put("workers", existing.id, existing);
  f.state.put("workerKeys", `worker:${f.job.id}:implement-example`, existing.id);
  f.runtime.api = async () => { throw new Error("Unexpected external task/worker API call"); };
  f.runtime.completeJob(f.job.id, "Timeout", "turn_timeout");
  f.state.transaction(() => f.runtime.requeueChat(f.job.id, "Verified the existing PR and worker; reuse their stable operation key."));
  const resumed = f.runtime.nextJob("resumed", 1)!;
  const returned = await f.runtime.startWorker(resumed.job, "Continue authorized work", "implement-example");
  assert.equal(returned.id, existing.id); assert.equal(returned.taskId, existing.taskId);
  assert.equal(returned.result, existing.result); assert.equal(returned.branch, existing.branch);
  assert.equal(f.state.all("workers").length, 1); assert.equal(f.state.all("outbox").length, 0);
});

test("dead runner recovers only matching-attempt public journal before completion", t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, `${f.job.id}.0.progress.json`), JSON.stringify([{key:"0:tool",kind:"activity",text:"Checking files"}]));
  writeFileSync(join(f.dir, `${f.job.id}.1.progress.json`), JSON.stringify([{key:"1:tool",kind:"activity",text:"Wrong future attempt"}]));
  saveReceipt(join(f.dir, `${f.job.id}.0.completion.json`), { jobId:f.job.id,attempt:0,text:"Final" });
  reconcileDeadTurn(f.runtime, f.dir, f.job.id, dead);
  assert.deepEqual(f.runtime.getProgress(f.job.id).map(p=>p.text), ["Checking files"]);
  assert.equal(f.runtime.job(f.job.id).status,"completed");
});


test("chat and every background turn use validated independent hour budgets", () => {
  const defaults = turnTimeouts({});
  assert.deepEqual(defaults, { chatMs: 3600000, backgroundMs: 3600000 });
  for (const kind of ["chat", "task", "worker_result", "review", "notification", "future-background-kind"]) {
    assert.deepEqual(turnDeadlines(kind, defaults), { runtimeSeconds: 3600, stopSeconds: 5, watchdogMs: 3610000 });
  }
  const custom = turnTimeouts({ CODEPAT_CHAT_TIMEOUT_MS: "120000", CODEPAT_BACKGROUND_TIMEOUT_MS: "900000" });
  assert.equal(turnDeadlines("chat", custom).runtimeSeconds, 120);
  assert.equal(turnDeadlines("review", custom).runtimeSeconds, 900);
  assert.equal(turnDeadlines("worker_result", custom).watchdogMs, 910000);
  assert.equal(turnTimeouts({CODEPAT_CHAT_TIMEOUT_MS: "600000"}).backgroundMs, 3600000);
  for (const key of ["CODEPAT_CHAT_TIMEOUT_MS", "CODEPAT_BACKGROUND_TIMEOUT_MS"])
    for (const value of ["", "0", "59999", "60001", "3600001", "Infinity", "oops"])
      assert.throws(() => turnTimeouts({[key]: value}), new RegExp(key));
  assert.equal(failureKind("timeout", 1, false, false, true), "turn_timeout");
  assert.equal(failureKind("success", 0, true, false, true), "turn_timeout");
});


test("terminal provider diagnosis survives runner death without replaying the turn", t => {
  const f = fixture(t);
  const stem = `${f.job.id}.0`;
  saveReceipt(join(f.dir, `${stem}.turn.json`), {jobId:f.job.id,attempt:0,launched:true,failure:"provider_policy"});
  assert.equal(reconcileDeadTurn(f.runtime,f.dir,f.job.id,dead),true);
  assert.equal(f.runtime.job(f.job.id).status,"failed");
  assert.equal(f.runtime.job(f.job.id).error,"provider_policy");
  assert.equal(f.runtime.nextJob("replacement",1),null);
  assert.equal(f.state.all("workers").length,0);
  assert.equal(f.state.all("deliveries").length,0);
});

test("unrecognized persisted diagnostic cannot become user text or authorize retry", t => {
  const f = fixture(t);
  saveReceipt(join(f.dir, `${f.job.id}.0.turn.json`), {jobId:f.job.id,attempt:0,launched:true,failure:"private-injected-body"});
  reconcileDeadTurn(f.runtime,f.dir,f.job.id,dead);
  assert.equal(f.runtime.job(f.job.id).error,"recovery_required");
  assert.doesNotMatch(JSON.stringify(f.runtime.job(f.job.id)),/private-injected-body/);
  assert.equal(f.runtime.nextJob("replacement",1),null);
});
