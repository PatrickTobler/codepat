import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, type Conversation, type Job, type Worker } from "./state.ts";
import { WorkerHolds } from "./worker-holds.ts";
import { approveRoutine } from "./routine-approval.ts";

function fixture() {
  const dir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "codepat-routine-"));
  const state = new State(join(dir, "state.sqlite"));
  const conversation: Conversation = { id: "conversation", owner: "owner", metadata: { sokosumi_organization_id: "org" } };
  const job: Job = { id: "job", conversationId: conversation.id, kind: "chat", input: "authorized task", status: "in_progress", text: "", createdAt: 0 };
  const worker: Worker = { id: "worker", name: "worker", conversationId: conversation.id, taskId: "task", repo: dir, worktree: dir, branch: "branch", prompt: "task", paneId: "pane", generation: 1, state: "blocked", recoveryHold: true, createdAt: 0, observedAt: 0 };
  state.put("conversations", conversation.id, conversation);
  state.put("jobs", job.id, job);
  state.put("workers", worker.id, worker);
  const calls: string[][] = [];
  const runtime = {
    state,
    herdr: { call: async (args: string[]) => { calls.push(args); return {}; }, agents: async () => [{ pane_id: "pane", agent_status: "blocked", name: "worker", cwd: dir }], prompt: async () => {} },
    workerAgent: async () => ({ pane_id: "pane", agent_status: "blocked", name: "worker", cwd: dir }),
    assertAssigned: async () => ({ ownerId: "owner", organizationId: "org", assigneeId: "coworker", status: "RUNNING" }),
    assertTaskOwner: () => {},
  };
  return { dir, state, conversation, job, worker, runtime, calls };
}
function evidence(digest = "a".repeat(64)) {
  return { routine: true, category: "tests", key: "enter", actionDigest: digest, dialogFingerprint: "b".repeat(64), authorizationReference: "task request" };
}
function recordHold(f: ReturnType<typeof fixture>, actionDigest = "a".repeat(64)) {
  const holds = new WorkerHolds(f.state);
  const hold = holds.observe(f.worker, f.conversation);
  // observe intentionally skips legacy boolean holds; this test models a newly observed hold.
  f.worker.recoveryHold = false;
  holds.observe(f.worker, f.conversation);
  const current = f.state.all<import("./worker-holds.ts").WorkerHold>("workerHolds").at(-1)!;
  f.worker.holdId = current.id; f.worker.recoveryHold = true;
  f.state.put("workers", f.worker.id, f.worker);
  holds.recordAction(f.worker, f.conversation, { holdId: current.id, generation: 1, paneId: "pane", actionDigest, evidenceReference: "dialog" }, f.job.id);
}
test("routine approval requires recorded provenance and is idempotent", async () => {
  const f = fixture();
  try {
    recordHold(f);
    const first = await approveRoutine(f.runtime, f.job, f.worker, evidence());
    assert.equal(first.status, "accepted");
    assert.deepEqual(f.calls, [["agent", "send-keys", "pane", "enter"]]);
    const second = await approveRoutine(f.runtime, f.job, f.worker, evidence());
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(f.calls.length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("uncertain approval is fail-closed and cannot be replayed", async () => {
  const f = fixture();
  try {
    recordHold(f);
    f.runtime.herdr.call = async () => { throw new Error("connection lost"); };
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /uncertain/);
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /uncertain/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("legacy boolean-only hold remains blocked", async () => {
  const f = fixture();
  try { await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /provenance/); }
  finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("owned worker event can use standing routine authorization without a new chat", async () => {
  const f = fixture();
  try {
    recordHold(f);
    const eventJob = { ...f.job, id: "worker-event:worker:1", kind: "worker" as const };
    const result = await approveRoutine(f.runtime, eventJob, f.worker, evidence(), true);
    assert.equal(result.status, "accepted");
    assert.deepEqual(f.calls, [["agent", "send-keys", "pane", "enter"]]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("chat-only routine approval cannot be used as a worker event and vice versa", async () => {
  const f = fixture();
  try {
    recordHold(f);
    const eventJob = { ...f.job, id: "worker-event:worker:1", kind: "worker" as const };
    await assert.rejects(() => approveRoutine(f.runtime, eventJob, f.worker, evidence()), /active owner chat/);
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence(), true), /owned worker event/);
    assert.equal(f.calls.length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
