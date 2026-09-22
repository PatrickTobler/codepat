import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { State, type Conversation, type Job, type Worker } from "./state.ts";
import { WorkerHolds } from "./worker-holds.ts";
import { approveRoutine, recognizedDialog } from "./routine-approval.ts";

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
    herdr: { call: async (args: string[]) => { calls.push(args); return args[1] === "read" ? { text: "Action: npm test\n> Yes (SELECTED)" } : {}; }, agents: async () => [{ pane_id: "pane", agent_status: "blocked", name: "worker", cwd: dir }], prompt: async () => {} },
    workerAgent: async () => ({ pane_id: "pane", agent_status: "blocked", name: "worker", cwd: dir }),
    assertAssigned: async () => ({ ownerId: "owner", organizationId: "org", assigneeId: "coworker", status: "RUNNING" }),
    assertTaskOwner: () => {},
  };
  return { dir, state, conversation, job, worker, runtime, calls };
}
function evidence(digest = "a".repeat(64)) {
  return { routine: true, category: "tests", key: "enter", actionDigest: digest, actionText: "npm test", dialogFingerprint: createHash("sha256").update("Action: npm test\n> Yes (SELECTED)").digest("hex"), authorizationReference: "task request" };
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
    holds.recordAction(f.worker, f.conversation, { holdId: current.id, generation: 1, paneId: "pane", actionDigest, actionText: "npm test", evidenceReference: "dialog" }, f.job.id);
}
test("provider dialog parser uses one trailing block and exact one-time options", () => {
  assert.deepEqual(recognizedDialog("Action: npm test\nDo you want to proceed?\n❯ 1. Yes"), { action: "npm test", selected: "yes" });
  assert.equal(recognizedDialog("Action: npm test\nDo you want to proceed?\n❯ 1. Yes, allow all edits during this session"), undefined);
  assert.equal(recognizedDialog("Action: npm test\n❯ 1. Yes\n❯ 2. No"), undefined);
  assert.equal(recognizedDialog("Action: npm test\noutput > yes, proceeding\nAction: rm -rf ~/workspaces\nDo you want to proceed?\n❯ 1. No"), undefined);
});
test("routine approval requires recorded provenance and is idempotent", async () => {
  const f = fixture();
  try {
    recordHold(f);
    const first = await approveRoutine(f.runtime, f.job, f.worker, evidence());
    assert.equal(first.status, "accepted");
    assert.deepEqual(f.calls, [["agent", "read", "pane", "--source", "recent-unwrapped", "--lines", "80"], ["agent", "send-keys", "pane", "enter"]]);
    const second = await approveRoutine(f.runtime, f.job, f.worker, evidence());
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(second.keySent, false);
    assert.equal(f.calls.length, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("uncertain approval is fail-closed and cannot be replayed", async () => {
  const f = fixture();
  try {
    recordHold(f);
    f.runtime.herdr.call = async (args: string[]) => { if (args[1] === "read") return { text: "Action: npm test\n> Yes (SELECTED)" }; throw new Error("connection lost"); };
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /uncertain/);
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /uncertain/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("legacy boolean-only hold remains blocked", async () => {
  const f = fixture();
  try { await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, evidence()), /provenance/); }
  finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("changed dialog fingerprint is inspected but never approved", async () => {
  const f = fixture();
  try {
    recordHold(f);
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, { ...evidence(), dialogFingerprint: "c".repeat(64) }), /dialog changed/);
    assert.deepEqual(f.calls, [["agent", "read", "pane", "--source", "recent-unwrapped", "--lines", "80"]]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("recognized dialog must match the recorded action and affirmative selection", async () => {
  const f = fixture();
  try {
    recordHold(f);
    f.runtime.herdr.call = async (args: string[]) =>
      args[1] === "read"
        ? { text: "Action: delete production database\n> Yes (SELECTED)" }
        : {};
    const changedAction = evidence();
    changedAction.dialogFingerprint = createHash("sha256")
      .update("Action: delete production database\n> Yes (SELECTED)")
      .digest("hex");
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, changedAction), /action does not match/);
    assert.equal(f.calls.some((args) => args[1] === "send-keys"), false);

    f.runtime.herdr.call = async (args: string[]) =>
      args[1] === "read"
        ? { text: "Action: npm test\n> No (SELECTED)" }
        : {};
    const declined = evidence();
    declined.dialogFingerprint = createHash("sha256")
      .update("Action: npm test\n> No (SELECTED)")
      .digest("hex");
    await assert.rejects(() => approveRoutine(f.runtime, f.job, f.worker, declined), /format or selected option/);
    assert.equal(f.calls.some((args) => args[1] === "send-keys"), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("owned worker event can use standing routine authorization without a new chat", async () => {
  const f = fixture();
  try {
    recordHold(f);
    const eventJob = { ...f.job, id: "worker-event:worker:1", kind: "worker" as const };
    const result = await approveRoutine(f.runtime, eventJob, f.worker, evidence(), true);
    assert.equal(result.status, "accepted");
    assert.deepEqual(f.calls, [["agent", "read", "pane", "--source", "recent-unwrapped", "--lines", "80"], ["agent", "send-keys", "pane", "enter"]]);
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
