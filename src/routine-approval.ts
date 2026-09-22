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
export const canonical = (value: string) => value.trim().replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
const oneTimeOptions = new Set(["yes", "allow", "approve", "continue", "run", "accept"]);
function selectedOption(line: string): string | undefined {
  if (!/^(?:❯|>|›)\s*/u.test(line) && !/\(SELECTED\)\s*$/i.test(line)) return undefined;
  return canonical(line.replace(/^(?:❯|>|›)\s*/u, "").replace(/\s*\(SELECTED\)\s*$/i, "").replace(/^\d+[.)]\s*/, "").replace(/[.!:]+$/, "")).toLowerCase();
}
export function recognizedDialog(text: string): { action: string; selected: string } | undefined {
  const lines = canonical(text).split("\n");
  const prompts = lines.flatMap((line, index) => /do you want to proceed\?\s*$/i.test(line) ? [index] : []);
  const prompt = prompts.at(-1);
  if (prompt !== undefined && prompts.length !== 1) return undefined;
  const boxHeaders = lines.flatMap((line, index) => /^(?:[│|]\s*)?bash command\s*(?:[│|]\s*)?$/i.test(line) ? [index] : []);
  const boxStart = boxHeaders.filter(index => prompt === undefined || index < prompt).at(-1);
  let action: string | undefined;
  let block: string[];
  if (boxStart !== undefined && prompt !== undefined) {
    const boxLines = lines.slice(boxStart + 1, prompt);
    if (!boxLines.length || boxLines.some(line => line.trim() && !/^[│|]/.test(line))) return undefined;
    const content = boxLines.map(line => line.replace(/^[│|]\s?/, "").replace(/\s*[│|]\s*$/, "").trim()).filter(Boolean);
    if (!content.length) return undefined;
    action = canonical(content.join("\n"));
    block = lines.slice(boxStart);
  } else {
    const actionIndexes = lines.flatMap((line, index) => /^(?:action|command|request):\s*.+$/i.test(line) ? [index] : []);
    const commandIndexes = lines.flatMap((line, index) => /^(?:[│|]\s*)?\$\s+.+$/.test(line) ? [index] : []);
    const actionStart = actionIndexes.filter(index => prompt === undefined || index < prompt).at(-1);
    const commandStart = commandIndexes.filter(index => prompt === undefined || index < prompt).at(-1);
    const start = Math.max(actionStart ?? -1, commandStart ?? -1);
    if (start < 0) return undefined;
    block = lines.slice(start);
    if (actionStart !== undefined && actionStart >= (commandStart ?? -1)) {
      const header = /^(?:action|command|request):\s*(.+)$/i.exec(lines[actionStart]);
      if (!header) return undefined;
      const between = lines.slice(actionStart + 1, prompt ?? lines.length).filter(line => line.trim());
      if (between.some(line => selectedOption(line) === undefined)) return undefined;
      action = canonical(header[1]);
    } else {
      const first = /^(?:[│|]\s*)?\$\s+(.+)$/.exec(lines[commandStart!]);
      if (!first) return undefined;
      const continuation = lines.slice(commandStart! + 1, prompt ?? lines.length);
      if (continuation.some(line => line.trim() && !/^\s+(?:[^❯>›]|$)/u.test(line))) return undefined;
      const commandLines = [first[1], ...continuation.filter(line => line.trim()).map(line => line.trim())];
      action = canonical(commandLines.join("\n"));
    }
  }
  const selected = block.slice(prompt === undefined ? 0 : block.indexOf(lines[prompt]) + 1).flatMap(line => { const option = selectedOption(line); return option === undefined ? [] : [option]; });
  if (!action || selected.length !== 1 || !oneTimeOptions.has(selected[0])) return undefined;
  return { action, selected: selected[0] };
}

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
  const evidenceActionText = textField(evidence, "actionText");
  const dialogFingerprint = textField(evidence, "dialogFingerprint");
  if (evidence.routine !== true || !categories.has(category) || key !== "enter" ||
      !digest.test(actionDigest) || !digest.test(dialogFingerprint) || !reference || reference.length > 1000 || evidenceActionText.length > 2000)
    throw new Error("Routine approval needs a bounded authorized category, exact dialog fingerprint, and enter key");
  const hold = worker.holdId ? runtime.state.get<import("./worker-holds.ts").WorkerHold>("workerHolds", worker.holdId) : undefined;
  if (!hold || hold.workerId !== worker.id || hold.generation !== (worker.generation ?? 0) ||
      hold.paneId !== worker.paneId || hold.conversationId !== conversation.id || hold.owner !== conversation.owner ||
      hold.organization !== conversation.metadata.sokosumi_organization_id || hold.actionDigest !== actionDigest || hold.decision)
    throw new Error("Exact recorded worker-dialog provenance is required; historical or unknown holds remain blocked");
  const task = await runtime.assertAssigned(worker.taskId);
  runtime.assertTaskOwner(task, conversation);
  const receiptId = createHash("sha256").update(JSON.stringify([worker.id, worker.generation ?? 0, worker.paneId, actionDigest])).digest("hex");
  const prior = runtime.state.get<{status: string}>("routineApprovals", receiptId);
  if (prior?.status === "accepted") return { status: "accepted", keySent: false, receiptId, workerId: worker.id, note: "This approval receipt was already accepted; no key was replayed." };
  if (prior?.status === "sending" || prior?.status === "uncertain") throw new Error("Approval outcome is uncertain; inspect before retrying");
  const live = await runtime.workerAgent(worker);
  if (!live || live.agent_status !== "blocked") throw new Error("The exact owned worker dialog is no longer blocked");
  const dialog = await runtime.herdr.call(["agent", "read", worker.paneId, "--source", "recent-unwrapped", "--lines", "80"]);
  const dialogText = typeof dialog.text === "string" ? dialog.text : JSON.stringify(dialog);
  const parsed = recognizedDialog(dialogText);
  if (!parsed) throw new Error("The worker dialog format or selected option is not recognized as a routine approval");
  const observedFingerprint = createHash("sha256").update(dialogText).digest("hex");
  if (observedFingerprint !== dialogFingerprint) throw new Error("The inspected worker dialog changed; no approval key sent");
  const observedActionDigest = createHash("sha256").update(canonical(parsed.action)).digest("hex");
  if (!hold.actionTextDigest || observedActionDigest !== hold.actionTextDigest) throw new Error("The live dialog action does not match the recorded routine action");
  if (canonical(evidenceActionText) !== canonical(parsed.action)) throw new Error("Approval evidence action does not match the inspected worker dialog");
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
  runtime.state.transaction(() => {
    runtime.state.put("routineApprovals", receiptId, { receiptId, workerId: worker.id, jobId: job.id, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, dialogFingerprint, reference, category, status: "accepted", at: Date.now() });
    const approvedHold = runtime.state.get<import("./worker-holds.ts").WorkerHold>("workerHolds", worker.holdId!);
    if (approvedHold) {
      approvedHold.routineApprovedAt = Date.now();
      approvedHold.routineApprovalReference = reference;
      runtime.state.put("workerHolds", approvedHold.id, approvedHold);
    }
  });
  const updated = runtime.state.get<Worker>("workers", worker.id);
  if (updated && updated.paneId === worker.paneId && updated.generation === worker.generation) {
    updated.routineApproval = { receiptId, generation: worker.generation ?? 0, paneId: worker.paneId, actionDigest, status: "accepted", at: Date.now() };
    runtime.state.put("workers", updated.id, updated);
  }
  return { status: "accepted", receiptId, workerId: worker.id, generation: worker.generation ?? 0 };
}
