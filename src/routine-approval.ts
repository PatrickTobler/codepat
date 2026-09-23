import {ControlConflict} from "./control-error.ts";
import {claudeGutterDialog} from "./claude-dialog.ts";
import { createHash } from "node:crypto";
import { State, record, textField, type Conversation, type Job, type Worker } from "./state.ts";
import { WorkerHolds } from "./worker-holds.ts";
import type { Agent, HerdrPort } from "./herdr.ts";
import { ACTION_TEXT_VERSION, canonicalActionText, unambiguousActionText } from "./action-text.ts";

export interface RoutineApprovalRuntime {
  state: State;
  herdr: HerdrPort;
  workerAgent(worker: Worker): Promise<Agent | undefined>;
  assertAssigned(id: string): Promise<Record<string, unknown>>;
  assertTaskOwner(task: Record<string, unknown>, conversation: Conversation): void;
}

const categories = new Set(["read-only", "tests", "dependency-install"]);
const digest = /^[a-f0-9]{64}$/;
export const canonical = canonicalActionText;
const oneTimeOptions = new Set(["yes", "allow", "approve", "continue", "run", "accept"]);
function selectedOption(line: string): string | undefined {
  if (!/^(?:❯|>|›)\s*/u.test(line) && !/\(SELECTED\)\s*$/i.test(line)) return undefined;
  return canonical(line.replace(/^(?:❯|>|›)\s*/u, "").replace(/\s*\(SELECTED\)\s*$/i, "").replace(/^\d+[.)]\s*/, "").replace(/[.!:]+$/, "")).toLowerCase();
}
export function recognizedDialog(text: string): { action: string; selected: string } | undefined {
  if (!unambiguousActionText(text)) return undefined;
  const gutter = claudeGutterDialog(text);
  if (gutter) return gutter.selected === "yes" ? {action: gutter.action, selected: "yes"} : undefined;
  const lines = canonical(text).split("\n");
  const prompts = lines.flatMap((line, index) => /do you want to proceed\?\s*$/i.test(line) ? [index] : []);
  const prompt = prompts.at(-1);
  if (prompt !== undefined && prompts.length !== 1) return undefined;
  const boxHeaders = lines.flatMap((line, index) => /^(?:[│|]\s*)?bash command\s*(?:[│|]\s*)?$/i.test(line) ? [index] : []);
  const boxStart = boxHeaders.filter(index => prompt === undefined || index < prompt).at(-1);
  let action: string | undefined;
  let block: string[];
  if (boxStart !== undefined && prompt !== undefined) {
    const topBorder = boxStart > 0 && /^\s*[╭┌].*[╮┐]\s*$/u.test(lines[boxStart - 1]) ? boxStart - 1 : -1;
    const bottomBorder = lines.findIndex((line, index) => index > boxStart && /^\s*[╰└].*[╯┘]\s*$/u.test(line));
    const bordered = topBorder >= 0;
    if (bottomBorder >= 0 && !bordered) return undefined;
    if (bordered && (bottomBorder < 0 || bottomBorder > prompt)) return undefined;
    const providerMetadata = new Set(["Tip: auto mode handles these prompts for you", "This command requires approval"]);
    if (bottomBorder >= 0 && lines.slice(bottomBorder + 1, prompt).some(line => line.trim() && !providerMetadata.has(line.trim()))) return undefined;
    const end = bottomBorder >= 0 && bottomBorder < prompt ? bottomBorder : prompt;
    const boxLines = lines.slice(boxStart + 1, end);
    if (!boxLines.length || boxLines.some(line => line.trim() && !/^[│|]/.test(line))) return undefined;
    const content = boxLines.map(line => {
      let value = line.replace(/^[│|]/, "").replace(/^ /, "");
      if (bordered && /│\s*$/u.test(value)) {
        value = value.replace(/\s+$/u, "");
        if (value.endsWith("│")) value = value.slice(0, -1).replace(/ $/u, "");
      }
      return value;
    });
    if (!content.some(line => line.trim())) return undefined;
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
      if (prompt !== undefined && between.length) return undefined;
      if (prompt === undefined && between.some(line => selectedOption(line) === undefined)) return undefined;
      action = canonical(header[1]);
    } else {
      const first = /^(?:[│|]\s*)?\$\s+(.+)$/.exec(lines[commandStart!]);
      if (!first) return undefined;
      const continuation = lines.slice(commandStart! + 1, prompt ?? lines.length);
      if (continuation.some(line => line.trim() && !/^\s+(?:[^❯>›]|$)/u.test(line))) return undefined;
      const commandLines = [first[1], ...continuation];
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
    throw new ControlConflict(workerEvent ? "Routine approval requires an owned worker event" : "Routine approval requires the active owner chat");
  const conversation = runtime.state.get<Conversation>("conversations", job.conversationId);
  const owning = runtime.state.get<Conversation>("conversations", worker.conversationId);
  if (!conversation || !owning || conversation.owner !== owning.owner ||
      conversation.metadata.sokosumi_organization_id !== owning.metadata.sokosumi_organization_id ||
      worker.conversationId !== job.conversationId)
    throw new ControlConflict("Worker approval is outside the owning conversation or organization");
  if (!worker.paneId || !worker.taskId) throw new ControlConflict("An assigned live worker pane is required");
  const evidence = record(input);
  const required = ["actionDigest", "authorizationReference", "category", "key", "actionText", "dialogFingerprint"];
  if (required.some(key => typeof evidence[key] !== "string" || !evidence[key]))
    throw new ControlConflict("Routine approval needs exact evidence fields: " + required.join(", "));
  const actionDigest = textField(evidence, "actionDigest");
  const reference = textField(evidence, "authorizationReference");
  const category = textField(evidence, "category");
  const key = textField(evidence, "key");
  const evidenceActionText = textField(evidence, "actionText");
  const dialogFingerprint = textField(evidence, "dialogFingerprint");
  if (evidence.routine !== true || !categories.has(category) || key !== "enter" ||
      !digest.test(actionDigest) || !digest.test(dialogFingerprint) || reference.length > 1000 || evidenceActionText.length > 2000)
    throw new ControlConflict("Routine approval needs a bounded authorized category, exact dialog fingerprint, and enter key");
  const hold = worker.holdId ? runtime.state.get<import("./worker-holds.ts").WorkerHold>("workerHolds", worker.holdId) : undefined;
  if (!hold || hold.actionTextVersion !== ACTION_TEXT_VERSION || hold.workerId !== worker.id || hold.generation !== (worker.generation ?? 0) ||
      hold.paneId !== worker.paneId || hold.taskId !== worker.taskId || hold.conversationId !== conversation.id || hold.owner !== conversation.owner ||
      hold.organization !== conversation.metadata.sokosumi_organization_id || hold.actionDigest !== actionDigest || hold.decision || hold.resolvedAt)
    throw new ControlConflict("Exact recorded worker-dialog provenance is required; historical or unknown holds remain blocked");
  if (hold.dialogFingerprint && hold.dialogFingerprint !== dialogFingerprint)
    throw new ControlConflict("Recorded dialog changed; inspect the hold rather than replacing its evidence");
  const assertCurrent = () => {
    const current = runtime.state.get<Worker>("workers", worker.id);
    const currentC = runtime.state.get<Conversation>("conversations", conversation.id);
    const currentJob = runtime.state.get<Job>("jobs", job.id);
    const currentHold = runtime.state.get<typeof hold>("workerHolds", hold.id);
    if (!current || current.paneId !== worker.paneId || current.generation !== worker.generation || current.taskId !== worker.taskId ||
        current.name !== worker.name || current.worktree !== worker.worktree || current.kind !== worker.kind || current.conversationId !== conversation.id ||
        current.holdId !== hold.id || !current.recoveryHold || currentHold?.resolvedAt || currentHold?.decision ||
        JSON.stringify(currentHold) !== JSON.stringify(hold) || currentC?.owner !== conversation.owner ||
        currentC?.metadata.sokosumi_organization_id !== conversation.metadata.sokosumi_organization_id ||
        currentJob?.status !== "in_progress" || currentJob.generation !== job.generation || currentJob.conversationId !== job.conversationId || currentJob.kind !== job.kind)
      throw new ControlConflict("Worker identity, owner, job or hold changed during approval; inspect again");
  };
  assertCurrent();
  const task = await runtime.assertAssigned(worker.taskId);
  runtime.assertTaskOwner(task, conversation);
  assertCurrent();
  // Retain the deployed receipt key: changing it could replay an older uncertain key.
  const receiptId = createHash("sha256").update(JSON.stringify([worker.id, worker.generation ?? 0, worker.paneId, actionDigest])).digest("hex");
  const prior = runtime.state.get<{status: string; holdId?: string; sessionId?: string; dialogFingerprint?: string}>("routineApprovals", receiptId);
  if (prior?.status === "sending" || prior?.status === "uncertain") throw new ControlConflict("Approval outcome is uncertain; inspect the same session and reconcile real decision evidence, never resend the key");
  if (prior?.status === "accepted") {
    if ((prior.holdId && prior.holdId !== hold.id) || (prior.sessionId && prior.sessionId !== evidence.sessionId) || prior.dialogFingerprint !== dialogFingerprint)
      throw new ControlConflict("Existing one-time approval receipt differs; no key replayed");
    return { status: "accepted", keySent: false, receiptId, workerId: worker.id, note: "Key transport was already acknowledged; verify command outcome separately. No key replayed." };
  }
  const live = await runtime.workerAgent(worker);
  if (!live || live.agent_status !== "blocked") throw new ControlConflict("The exact owned worker dialog is no longer blocked; reconcile its real decision instead");
  const dialog = await runtime.herdr.call(["agent", "read", worker.paneId, "--source", "recent-unwrapped", "--lines", "80"]);
  const dialogText = typeof dialog.text === "string" ? dialog.text : "";
  const parsed = recognizedDialog(dialogText);
  if (!parsed) throw new ControlConflict("The worker dialog format or selected option is unsupported; inspect-worker-hold and select only a known one-time Yes through the authorized human/provider flow");
  const gutter = claudeGutterDialog(dialogText);
  if (gutter || worker.kind === "claude" || hold.sessionId) {
    if (workerEvent && (job.workerId !== worker.id || job.taskId !== worker.taskId)) throw new ControlConflict("Routine coordination requires the exact worker/task event, not an unrelated autonomous job");
    if (!live.agent_session_id || !hold.sessionId || evidence.sessionId !== live.agent_session_id || hold.sessionId !== live.agent_session_id ||
        evidence.holdId !== hold.id || evidence.generation !== (worker.generation ?? 0) || evidence.paneId !== worker.paneId || hold.dialogFingerprint !== dialogFingerprint)
      throw new ControlConflict("Exact recorded hold/session/generation/pane/fingerprint binding required; inspect-worker-hold then record-worker-hold");
  }
  if (createHash("sha256").update(dialogText).digest("hex") !== dialogFingerprint)
    throw new ControlConflict("The inspected worker dialog changed; no approval key sent");
  if (!hold.actionTextDigest || createHash("sha256").update(canonical(parsed.action)).digest("hex") !== hold.actionTextDigest || canonical(evidenceActionText) !== canonical(parsed.action))
    throw new ControlConflict("The live dialog action does not match the recorded routine action");
  const finalLive = await runtime.workerAgent(worker);
  if (!finalLive || finalLive.agent_status !== "blocked" || finalLive.agent_session_id !== live.agent_session_id)
    throw new ControlConflict("Worker session or dialog changed before approval; no key sent");
  const finalDialog = await runtime.herdr.call(["agent", "read", worker.paneId, "--source", "recent-unwrapped", "--lines", "80"]);
  if (typeof finalDialog.text !== "string" || createHash("sha256").update(finalDialog.text).digest("hex") !== dialogFingerprint)
    throw new ControlConflict("The inspected worker dialog changed before approval; no key sent");
  const receipt = {receiptId, workerId: worker.id, jobId: job.id, owner: conversation.owner, organization: hold.organization,
    taskId: worker.taskId, holdId: hold.id, sessionId: live.agent_session_id, generation: worker.generation ?? 0,
    paneId: worker.paneId, actionDigest, dialogFingerprint, reference, category, at: Date.now()};
  runtime.state.transaction(() => {
    assertCurrent();
    if (runtime.state.get("routineApprovals", receiptId)) throw new ControlConflict("Approval receipt already reserved; inspect it before retrying");
    runtime.state.put("routineApprovals", receiptId, {...receipt, status: "sending"});
  });
  try {
    await runtime.herdr.call(["agent", "send-keys", worker.paneId, "enter"]);
  } catch {
    runtime.state.put("routineApprovals", receiptId, {...receipt, status: "uncertain"});
    throw new ControlConflict("Approval key outcome is uncertain; inspect the same session and reconcile real decision evidence, never resend the key");
  }
  runtime.state.transaction(() => {
    runtime.state.put("routineApprovals", receiptId, {...receipt, status: "accepted"});
    const approvedHold = runtime.state.get<typeof hold>("workerHolds", hold.id);
    if (JSON.stringify(approvedHold) === JSON.stringify(hold)) {
      approvedHold!.routineApprovedAt = Date.now();
      approvedHold!.routineApprovalReference = reference;
      runtime.state.put("workerHolds", hold.id, approvedHold);
    }
    const updated = runtime.state.get<Worker>("workers", worker.id);
    if (updated && updated.paneId === worker.paneId && updated.generation === worker.generation && updated.holdId === hold.id) {
      updated.routineApproval = { receiptId, generation: worker.generation ?? 0, paneId: worker.paneId!, actionDigest, status: "accepted", at: Date.now() };
      runtime.state.put("workers", updated.id, updated);
    }
  });
  return { status: "accepted", receiptId, workerId: worker.id, generation: worker.generation ?? 0,
    note: "One-time key transport acknowledged. Keep the hold until the command outcome and closed same-session dialog are verified." };
}
