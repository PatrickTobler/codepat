import { dirname } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";

export function chatTimeoutMs(value: unknown = 600_000): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 60_000 || timeout > 3_600_000 || timeout % 1000)
    throw new Error("CODEPAT_CHAT_TIMEOUT_MS must be whole seconds between 60000 and 3600000");
  return timeout;
}
export function deadlines(timeout: number) {
  return { runtimeSeconds: chatTimeoutMs(timeout) / 1000, stopSeconds: 5, watchdogMs: timeout + 10_000 };
}
export interface TurnReceipt {
  jobId: string;
  attempt: number;
  launched: boolean;
  threadId?: string;
  completed?: boolean;
}
export function saveReceipt(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  const file = openSync(`${path}.tmp`, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(`${path}.tmp`, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function loadReceipt(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* no private file content in errors */ }
  throw new Error("Invalid recovery receipt; retained for inspection");
}
export function failureKind(result: string | undefined, exit: number, watchdog: boolean, stopping: boolean, hasText: boolean): string | undefined {
  if (result === "timeout") return "turn_timeout";
  if (result === "oom-kill") return "turn_oom_killed";
  if (result === "signal" || result === "core-dump") return "turn_signal";
  if (watchdog) return "turn_timeout";
  if (exit !== 0 || (result && !["success", "unknown"].includes(result))) return "turn_exit_failure";
  if (stopping && !hasText) return "turn_interrupted";
  if (!hasText) return "turn_empty_output";
  return undefined;
}
export function failureText(kind: string): string {
  const reasons: Record<string, string> = {
    turn_timeout: "CodePat reached its turn time limit.",
    turn_oom_killed: "The operating system reported an out-of-memory kill for this turn.",
    turn_signal: "The turn ended from a process signal.",
    turn_interrupted: "The turn was interrupted.",
    turn_exit_failure: "The turn exited unsuccessfully.",
    turn_empty_output: "The turn ended without a final answer.",
    recovery_required: "The previous turn stopped without a confirmed completion.",
    recovery_limit: "The bounded recovery limit was reached.",
  };
  return `${reasons[kind] ?? "The runner could not finish this turn."} Existing workers and actions remain tracked. Inspect completed actions and uncertain deliveries before requesting recovery; do not start duplicate work.`;
}

// Only the host supervisor calls this after checking the pane process and unit.
// Never steal a claim on age/heartbeat alone: a swapped-out process can be alive.
export function reconcileDeadTurn(
  runtime: import("./runtime.ts").Runtime,
  directory: string,
  id: string,
  evidence: { runnerGone: boolean; activeState: string; loadState: string },
): boolean {
  if (!evidence.runnerGone || (!['inactive', 'failed'].includes(evidence.activeState) && evidence.loadState !== 'not-found')) return false;
  const job = runtime.job(id);
  if (job.status !== "in_progress") return true;
  const stem = job.reservationProtocol === 1 ? `${job.id}.${job.generation ?? 0}` : job.id;
  try {
    const saved = loadReceipt(`${directory}/${stem}.completion.json`);
    const turn = loadReceipt(`${directory}/${stem}.turn.json`);
    const valid = (value: Record<string, unknown>) => value.jobId === id &&
      (job.reservationProtocol !== 1 || value.attempt === (job.generation ?? 0));
    if (saved && (!valid(saved) || typeof saved.text !== "string" ||
        (saved.error !== undefined && typeof saved.error !== "string") || (!saved.error && !saved.text.trim()))) throw new Error("Invalid completion");
    if (turn && (!valid(turn) || typeof turn.launched !== "boolean")) throw new Error("Invalid turn receipt");
    const thread = saved?.threadId ?? turn?.threadId;
    if (typeof thread === "string") runtime.state.put("threads", job.conversationId, thread);
    if (saved) runtime.completeJob(id, saved.text as string, saved.error as string | undefined);
    else if (turn?.completed === true && existsSync(`${directory}/${stem}.txt`)) {
      const text = readFileSync(`${directory}/${stem}.txt`, "utf8");
      if (text.trim()) runtime.completeJob(id, text);
      else runtime.recoverInterruptedJob(id, turn?.launched === true);
    } else runtime.recoverInterruptedJob(id, turn?.launched === true);
  } catch {
    runtime.completeJob(id, "Recovery evidence could not be validated. Retained the same job and private files for reconciliation; no actions were replayed.", "recovery_required");
  }
  return true;
}
