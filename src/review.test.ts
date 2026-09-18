import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Runtime } from "./runtime.ts";
import { Reviews, reviewInterval } from "./review.ts";
import { State, type Job, type Worker } from "./state.ts";
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://localhost:1", token: "synthetic" }));
  const state = new State(join(dir, "state.sqlite"));
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} }, { dataDir: dir, cliPath: "cli", repo: dir, apiUrl: "http://localhost:1" });
  const c = runtime.createConversation("owner-a", { sokosumi_organization_id: "organization-a", sokosumi_room_id: "synthetic-room" });
  const worker: Worker = { id: "worker-a", name: "synthetic", prompt: "Implement then obtain the required review; do not merge", repo: dir, worktree: dir, branch: "feature", conversationId: c.id, state: "working", createdAt: 0, observedAt: 0, generation: 1 };
  const add = () => state.put("workers", worker.id, worker);
  const due = () => { runtime.reviews.schedule(0); runtime.reviews.schedule(1_200_000); };
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, runtime, c, worker, add, due };
}

test("default twenty minutes, fake clock boundary and disable validation", t => {
  assert.equal(reviewInterval(), 1_200_000); assert.equal(reviewInterval(0), 0);
  for (const n of [-1, 1, NaN, 86400001]) assert.throws(() => reviewInterval(n));
  const f = fixture(t); f.add(); f.runtime.reviews.schedule(100);
  f.runtime.reviews.schedule(1_200_099); assert.equal(f.state.all("jobs").length, 0);
  f.runtime.reviews.schedule(1_200_100); assert.equal(f.state.all("jobs").length, 1);
  assert.equal(new Reviews(f.state, 0).claim(f.state.all<Job>("jobs")[0], 2_000_000), false);
});
test("no work, legacy unknown org, old completed worker and explicit waiting are silent", t => {
  const f = fixture(t); f.due(); assert.equal(f.state.all("jobs").length, 0);
  f.worker.state = "completed"; f.worker.result = "PR awaiting user approval"; f.add();
  f.runtime.reviews.schedule(2_400_000); assert.equal(f.state.all("jobs").length, 0);
  f.worker.state = "working"; f.add(); f.state.put("reviewWork", f.worker.id, { workerId: f.worker.id, state: "waiting", note: "Needs user approval" });
  f.runtime.reviews.schedule(3_600_000); assert.equal(f.state.all("jobs").length, 0);
  f.c.metadata = {}; f.state.put("conversations", f.c.id, f.c);
  f.runtime.reviews.schedule(4_800_000); assert.equal(f.state.all("jobs").length, 0);
});
test("durable pending dedupe after reopening SQLite and no catch-up storm", t => {
  const f = fixture(t); f.add(); f.due();
  const reopened = new State(join(f.dir, "state.sqlite"));
  const reviews = new Reviews(reopened, 1_200_000);
  reviews.schedule(20_000_000); reviews.schedule(20_000_001);
  assert.equal(reopened.all("jobs").length, 1);
  reopened.close();
});
test("chat priority and active turn prevent overlap; stale no-op is discarded at claim", t => {
  const f = fixture(t); f.add(); f.due();
  const chat = f.runtime.createResponse(f.c.owner, f.c.id, "User request");
  assert.equal(f.runtime.nextJob("runner", 1)!.job.id, chat.id);
  f.runtime.reviews.schedule(20_000_000); assert.equal(f.state.all("jobs").length, 2);
  assert.equal(f.runtime.nextJob("another", 1), null);
  f.runtime.completeJob(chat.id, "Answer");
  f.worker.state = "completed"; f.add();
  assert.equal(f.runtime.nextJob("runner", 1), null);
  assert.equal(f.state.all("outbox").length, 0);
});
test("review scope excludes other owner, organization AND conversations and never uses chat thread", async t => {
  const f = fixture(t); f.add();
  const other = f.runtime.createConversation("owner-b", { sokosumi_organization_id: "organization-b" });
  f.state.put("workers", "other", { ...f.worker, id: "other", conversationId: other.id });
  f.state.put("threads", f.c.id, "private-chat-thread");
  f.due(); const next = f.runtime.nextJob("runner", 1)!;
  assert.equal(next.job.conversationId, f.c.id); assert.equal(next.threadId, undefined);
  assert.doesNotMatch(JSON.stringify(next.context), /owner-b|organization-b|private-chat-thread|"other"/);
  assert.equal(f.runtime.workers(next.job).length, 1);
  await assert.rejects(f.runtime.control("review-work", { jobId: next.job.id, workerId: "other", state: "pending", text: "Cross-scope" }));
  await f.runtime.control("thread", { jobId: next.job.id, threadId: "review-thread" });
  assert.equal(f.state.get("threads", f.c.id), "private-chat-thread");
  f.c.owner = "changed"; f.state.put("conversations", f.c.id, f.c);
  await assert.rejects(f.runtime.control("workers", { jobId: next.job.id }));
});
test("worker scopes cannot inspect/configure reviews; active job scope can inspect its schedule", t => {
  const f = fixture(t); f.add();
  const cfg = f.runtime.scopedConfig({ kind: "worker", id: f.worker.id, generation: 1 });
  const token = JSON.parse(readFileSync(cfg, "utf8")).token;
  assert.equal(f.runtime.authorizeControl(token, "review-status", {}), false);
  f.due(); const next = f.runtime.nextJob("runner", 1)!;
  const jt = JSON.parse(readFileSync(next.jobConfig, "utf8")).token;
  assert.equal(f.runtime.authorizeControl(jt, "review-status", { jobId: next.job.id }), true);
});
test("stuck unchanged worker still gets real review each interval, unchanged notifications suppressed durably", t => {
  const f = fixture(t); f.worker.state = "blocked"; f.add(); f.due();
  const first = f.runtime.nextJob("runner", 1)!.job;
  f.runtime.completeJob(first.id, "Approval still needed"); assert.equal(f.state.all("outbox").length, 1);
  // Remove the synthetic notification from eligibility by confirming its delivery.
  for (const o of f.state.all<any>("outbox")) f.state.put("outbox", o.id, { ...o, status: "sent" });
  f.runtime.reviews.schedule(Date.now() + 1_200_001);
  const next = f.runtime.nextJob("runner", 1)!; assert.equal(next.job.kind, "review");
  f.runtime.completeJob(next.job.id, "Different wording of same approval blocker");
  assert.equal(f.state.all("outbox").length, 1);
  assert.equal(f.runtime.job(next.job.id).text, "");
});
test("NO_UPDATE, empty and failed review responses do not emit messages", t => {
  const f = fixture(t); f.add(); f.due();
  const j = f.runtime.nextJob("runner", 1)!.job; f.runtime.completeJob(j.id, "[NO_UPDATE]");
  assert.equal(f.runtime.job(j.id).text, ""); assert.equal(f.state.all("outbox").length, 0);
  f.runtime.reviews.schedule(Date.now() + 1_200_001); const j2 = f.runtime.nextJob("runner", 1)!.job;
  f.runtime.completeJob(j2.id, "Timeout failure", "turn_timeout"); assert.equal(f.state.all("outbox").length, 0);
});
test("blocked approvals, uncertain instructions and outbox effects prohibit periodic mutations", async t => {
  const f = fixture(t); f.worker.state = "blocked"; f.add(); f.due(); const j = f.runtime.nextJob("runner", 1)!.job;
  for (const action of ["send", "resume", "stop", "start", "recover-chat", "task-report"]) await assert.rejects(f.runtime.control(action, { jobId: j.id, workerId: f.worker.id, text: "Continue" }));
  f.worker.state = "idle"; f.add();
  f.state.put("deliveries", "uncertain", { id: "uncertain", workerId: f.worker.id, status: "uncertain" });
  await assert.rejects(f.runtime.control("resume", { jobId: j.id, workerId: f.worker.id, text: "Continue" }));
  f.state.put("deliveries", "uncertain", { id: "uncertain", workerId: f.worker.id, status: "sent" });
  f.runtime.outbox("/example", {}, f.c.id);
  for (const o of f.state.all<any>("outbox")) f.state.put("outbox", o.id, { ...o, status: "uncertain" });
  await assert.rejects(f.runtime.control("resume", { jobId: j.id, workerId: f.worker.id, text: "Continue" }));
});
test("new completed implementation stage remains discoverable, old completion and completed parent do not authorize work", async t => {
  const f = fixture(t); f.add();
  await f.runtime.control("worker-result", { workerId: f.worker.id, text: "Implementation stage complete; required independent review remains" });
  const notice = f.runtime.nextJob("runner", 1)!.job;
  f.runtime.completeJob(notice.id, "");
  assert.equal(f.runtime.reviews.evidence(f.c).needed, true);
  const chat = f.runtime.createResponse(f.c.owner, f.c.id, "Record remaining authorized stage"); f.runtime.nextJob("runner", 1);
  await f.runtime.control("review-work", { jobId: chat.id, workerId: f.worker.id, state: "pending", text: "Obtain previously requested independent review; do not merge" });
  f.runtime.completeJob(chat.id, "Recorded"); f.due();
  const review = f.runtime.nextJob("runner", 1)!.job;
  assert.equal(review.kind, "review");
  await f.runtime.control("review-work", { jobId: review.id, workerId: f.worker.id, state: "waiting", text: "Review complete; PR now awaits user approval" });
  await assert.rejects(f.runtime.control("review-work", { jobId: review.id, workerId: f.worker.id, state: "pending", text: "Invent continuation" }));
  assert.equal(f.runtime.reviews.evidence(f.c).needed, false);
  f.worker.taskId = "task-example"; f.add(); f.state.put("reviewTaskStatus", f.worker.taskId, "COMPLETED");
  f.state.put("reviewWork", f.worker.id, { state: "pending", note: "Old stage" });
  assert.equal(f.runtime.reviews.evidence(f.c).needed, false);
});
test("review context is bounded and excludes prompts/results and timestamp churn", t => {
  const f = fixture(t); f.add();
  for (let i = 0; i < 100; i++) f.state.put("workers", `w${i}`, { ...f.worker, id: `w${i}`, prompt: "PRIVATE LONG PROMPT", result: "PRIVATE RESULT" });
  const before = f.runtime.reviews.evidence(f.c).fingerprint;
  f.worker.observedAt = 90000; f.add();
  assert.equal(f.runtime.reviews.evidence(f.c).fingerprint, before);
  const ctx = f.runtime.reviews.context(f.c); assert.equal(ctx.workers.length, 20);
  assert.equal(ctx.totals.workers, 101); assert.doesNotMatch(JSON.stringify(ctx), /PRIVATE/);
});

test("failed periodic notification does not cause a notification feedback loop", t => {
  const f = fixture(t); f.add(); f.due();
  const j = f.runtime.nextJob("runner", 1)!.job; f.runtime.completeJob(j.id, "New blocker");
  const o = f.state.all<any>("outbox")[0]; assert.equal(o.reviewNotification, true);
  f.state.put("outbox", o.id, { ...o, status: "failed" });
  f.runtime.reviews.schedule(Date.now() + 1_200_001); const j2 = f.runtime.nextJob("runner", 1)!.job;
  f.runtime.completeJob(j2.id, "Same blocker, notification failed"); assert.equal(f.state.all("outbox").length, 1);
});
test("unresolved delivery alone is actionable, but unscoped outbox cannot leak to a review", t => {
  const f = fixture(t); f.worker.state = "completed"; f.add();
  f.runtime.outbox("/unscoped", { comment: "Unrelated" });
  assert.equal(f.runtime.reviews.evidence(f.c).needed, false);
  f.state.put("deliveries", "d", { id: "d", workerId: f.worker.id, status: "queued" });
  f.due(); const j = f.runtime.nextJob("runner", 1)!.job; assert.equal(j.kind, "review");
  assert.doesNotMatch(JSON.stringify(f.runtime.reviews.context(f.c)), /Unrelated|unscoped/);
});
test("owner change before claim or completion never delivers to replacement owner", t => {
  const f = fixture(t); f.add(); f.due();
  const j = f.runtime.nextJob("runner", 1)!.job;
  f.c.owner = "replacement"; f.state.put("conversations", f.c.id, f.c);
  f.runtime.completeJob(j.id, "Private update"); assert.equal(f.state.all("outbox").length, 0);
  f.runtime.reviews.schedule(Date.now() + 1_200_001); // scope change resets deadline
  assert.equal(f.runtime.nextJob("runner", 1), null);
});

test("same owner in another conversation or organization is not periodic scope", t => {
  const f = fixture(t); f.add();
  for (const organization of ["organization-a", "organization-b"]) {
    const c = f.runtime.createConversation(f.c.owner, { sokosumi_organization_id: organization });
    f.state.put("workers", c.id, { ...f.worker, id: c.id, conversationId: c.id });
  }
  f.due(); const j = f.runtime.nextJob("runner", 1)!.job;
  assert.deepEqual(f.runtime.workers(j).map(w => w.id), [f.worker.id]);
});
test("safe continuation preserves worker/task and queued instruction cannot be duplicated", async t => {
  const f = fixture(t); f.worker.state = "idle"; f.worker.taskId = "task-example"; f.worker.paneId = "pane-example"; f.add();
  f.runtime.config.coworkerId = "coworker-example";
  f.runtime.herdr.agents = async () => [{ pane_id: f.worker.paneId!, name: f.worker.name, cwd: f.worker.worktree, agent_status: "idle" }];
  let reads = 0;
  f.runtime.api = async (_path, method) => { assert.ok(!method || method === "GET"); reads++; return { data: { id: f.worker.taskId, ownerId: f.c.owner, organizationId: "organization-a", assigneeId: "coworker-example", status: "RUNNING" } }; };
  f.due(); const j = f.runtime.nextJob("runner", 1)!.job;
  await f.runtime.control("resume", { jobId: j.id, workerId: f.worker.id, text: "Continue the already authorized remaining checks" });
  assert.ok(reads >= 2); assert.equal(f.state.all("workers").length, 1); assert.equal(f.state.all("deliveries").length, 1);
  await assert.rejects(f.runtime.control("resume", { jobId: j.id, workerId: f.worker.id, text: "Duplicate" }));
  assert.equal(f.state.all("deliveries").length, 1);
  assert.equal(f.state.get<Worker>("workers", f.worker.id)!.taskId, "task-example");
});
test("live task owner/organization and approval status are revalidated before continuation", async t => {
  const f = fixture(t); f.worker.state = "idle"; f.worker.taskId = "task-example"; f.add();
  f.runtime.config.coworkerId = "coworker-example"; f.due(); const j = f.runtime.nextJob("runner", 1)!.job;
  for (const extra of [{ ownerId: "other-owner" }, { organizationId: "other-org" }, { status: "APPROVAL_REQUIRED" }]) {
    f.runtime.api = async () => ({ data: { ownerId: f.c.owner, organizationId: "organization-a", assigneeId: "coworker-example", status: "RUNNING", ...extra } });
    await assert.rejects(f.runtime.control("resume", { jobId: j.id, workerId: f.worker.id, text: "Continue" }));
  }
  assert.equal(f.state.all("deliveries").length, 0);
});
test("remaining review stage prevents premature parent completion until explicitly done", async t => {
  const f = fixture(t); f.worker.taskId = "task-example"; f.add();
  await f.runtime.control("worker-result", { workerId: f.worker.id, text: "Implementation ready" });
  assert.equal(f.runtime.taskHasUnfinishedWork("task-example"), true);
  const j = f.runtime.nextJob("runner", 1)!.job;
  await f.runtime.control("review-work", { jobId: j.id, workerId: f.worker.id, state: "waiting", text: "Waiting for approval" });
  assert.equal(f.runtime.taskHasUnfinishedWork("task-example"), true);
  await f.runtime.control("review-work", { jobId: j.id, workerId: f.worker.id, state: "done", text: "All required reviews verified" });
  assert.equal(f.runtime.taskHasUnfinishedWork("task-example"), false);
});

test("scope identity changes fail closed indefinitely rather than inheriting prior owner work", t => {
  const f = fixture(t); f.add(); f.runtime.reviews.schedule(0);
  f.c.metadata.sokosumi_organization_id = "replacement-org"; f.state.put("conversations", f.c.id, f.c);
  f.runtime.reviews.schedule(1_200_000); f.runtime.reviews.schedule(99_000_000);
  assert.equal(f.state.all("jobs").length, 0);
});

test("downtime emits one due review, then waits a full interval instead of replaying missed ticks", t => {
  const f = fixture(t); f.add(); f.runtime.reviews.schedule(0);
  const now = Date.now(); f.runtime.reviews.schedule(now);
  const j = f.runtime.nextJob("runner", 1)!.job; f.runtime.completeJob(j.id, "[NO_UPDATE]");
  f.runtime.reviews.schedule(now + 100); assert.equal(f.state.all("jobs").length, 1);
  f.runtime.reviews.schedule(now + 1_200_100); assert.equal(f.state.all("jobs").length, 2);
});
