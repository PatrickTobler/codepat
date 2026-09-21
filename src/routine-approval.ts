import { createHash } from "node:crypto";
import { State, record, textField, type Conversation, type Job, type Worker } from "./state.ts";
import { WorkerHolds } from "./worker-holds.ts";
import type { Agent, HerdrPort } from "./herdr.ts";

export interface RoutineApprovalRuntime {
  state: State;
  herdr: HerdrPort;
  workerAgent(worker: Worker): Promise<Agent | undefined>;
  assertAssigned(id: string): Promise<Record<string, unknown>>;
  assertTaskOwner(task: Record<string, unknown>, conversation: Conversation): void;
}

const categories = new Set(["read-only", "tests", "dependency-install"]);
const digest = /^[a-f0-9]{64}$/;

/** Approve one inspected, task-authorized dialog. This is deliberately not a generic key sender. */
export async function approveRoutine(
  runtime: RoutineApprovalRuntime,
  job: Job,
  worker: Worker,
  input: unknown,
  workerEvent = false,
): Promise<Record<string, unknown>> {
  if ((!workerEvent && job.kind !== "chat") || (workerEvent && job.kind !== "worker") || job.status !== "in_progress")
    throw new Error(workerEvent ? "Routine approval requires an owned worker event" : "Routine approval requires the active owner chat");
  const conversation = runtime.state.get<Conversation>("conversations", job.conversationId);
  const owning = runtime.state.get<Conversation>("conversations", worker.conversationId);
  if (!conversation || !owning || conversation.owner !== owning.owner ||
      conversation.metadata.sokosumi_organization_id !== owning.metadata.sokosumi_organization_id ||
      worker.conversationId !== job.conversationId)
    throw new Error("Worker approval is outside the owning conversation or organization");
  if (!worker.paneId || !worker.taskId) throw new Error("An assigned live worker pane is required");
  const evidence = record(input);
  const actionDigest = textField(evidence, "actionDigest");
  const reference = textField(evidence, "authorizationReference");
  const category = textField(evidence, "category");
  const key = textField(evidence, "key");
  const dialogFingerprint = textField(evidence, "dialogFingerprint");
  if (evidence.routine !== true || !categories.has(category) || key !== "enter" ||
      !digest.test(actionDigest) || !digest.test(dialogFingerprint) || !reference || reference.length > 1000)
    throw new Error("Routine approval needs a bounded authorized category, exact dialog fingerprint, and enter key");
  const hold = worker.holdId ? runtime.state.get<import("./worker-holds.ts").WorkerHold>("workerHolds", worker.holdId) : undefined;
  if (!hold || hold.workerId !== worker.id || hold.generation !== (worker.generation ?? 0) ||
      hold.paneId !== worker.paneId || hold.conversationId !== conversation.id || hold.owner !== conversation.owner ||
      hold.organization !== conversation.metadata.sokosumi_organization_id || hold.actionDigest !== actionDigest || hold.decision)
    throw new Error("Exact recorded worker-dialog provenance is required; historical or unknown holds remain blocked");
  const task = await runtime.assertAssigned(worker.taskId);
  runtime.assertTaskOwner(task, conversation);
  const live = await runtime.workerAgent(worker);
  if (!live || live.agent_status !== "blocked") throw new Error("The exact owned worker dialog is no longer blocked");
  const receiptId = createHash("sha256").update(JSON.stringify([job.id, worker.id, worker.generation ?? 0, worker.paneId, actionDigest, dialogFingerprint])).digest("hex");
  const prior = runtime.state.get<{status: string}>("routineApprovals", receiptId);
  if (prior?.status === "accepted") return { status: "accepted", receiptId, workerId: worker.id };
  if (prior?.status === "sending" || prior?.status === "uncertain") throw new Error("Approval outcome is uncertain; inspect before retrying");
  const current = runtime.state.get<Worker>("workers", worker.id);
  if (!current || current.paneId !== worker.paneId || current.generation !== worker.generation)
    throw new Error("Worker identity changed during approval");
  runtime.state.put("routineApprovals", receiptId, { receiptId, workerId: worker.id, jobId: job.id, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, dialogFingerprint, reference, category, status: "sending", at: Date.now() });
  try {
    await runtime.herdr.call(["agent", "send-keys", worker.paneId, key]);
  } catch (error) {
    runtime.state.put("routineApprovals", receiptId, { receiptId, workerId: worker.id, jobId: job.id, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, dialogFingerprint, reference, category, status: "uncertain", at: Date.now(), error: String(error).slice(0, 500) });
    throw new Error("Approval key outcome is uncertain; inspect the exact pane before retrying");
  }
  runtime.state.put("routineApprovals", receiptId, { receiptId, workerId: worker.id, jobId: job.id, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, dialogFingerprint, reference, category, status: "accepted", at: Date.now() });
  const updated = runtime.state.get<Worker>("workers", worker.id);
  if (updated && updated.paneId === worker.paneId && updated.generation === worker.generation) {
    updated.routineApproval = { receiptId, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, status: "accepted", at: Date.now() };
    runtime.state.put("workers", updated.id, updated);
  }
  return { status: "accepted", receiptId, workerId: worker.id, generation: worker.generation ?? 0 };
}
