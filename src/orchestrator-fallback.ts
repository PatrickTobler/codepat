import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Codex could not serve the turn at all. Policy rejections are deliberately
// excluded: another provider must not be used to route around them.
const unavailable = new Set([
  "provider_usage_limit",
  "provider_auth",
  "provider_rate_limit",
  "provider_connection",
  "provider_context_limit",
]);
// Fall back only when Codex failed before it produced any item: a turn that
// already ran commands or sent messages may have side effects we must not repeat.
export function shouldFallBack(failure: string | undefined, codexActed: boolean): boolean {
  return failure !== undefined && unavailable.has(failure) && !codexActed;
}
// One stable Claude session per conversation, so no extra state is persisted.
export function claudeSessionId(conversationId: string): string {
  const hex = createHash("sha256").update(`codepat:${conversationId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function claudeSessionExists(sessionId: string, cwd: string): boolean {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  return existsSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`));
}
// Turns resume the conversation's stable Claude session when one exists.
export function claudeArgs(options: { conversationId?: string; cwd: string }): string[] {
  const session = !options.conversationId
    ? ["--no-session-persistence"]
    : (() => {
        const id = claudeSessionId(options.conversationId);
        return claudeSessionExists(id, options.cwd) ? ["--resume", id] : ["--session-id", id];
      })();
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", ...session];
}
// Streaming input keeps the process alive while background tasks run; the runner closes it when the turn settles.
export function claudeInput(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}
// Compacts a conversation's Claude session so later turns stay fast.
export function claudeCompactArgs(conversationId: string): string[] {
  return ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--resume", claudeSessionId(conversationId), "/compact"];
}
export const FALLBACK_NOTE =
  "Codex is unavailable for this turn, so you are running as Claude Code in its place. Earlier Codex conversation history is not available to you. Inspect the live repository, task and Herdr state before acting, and do not assume earlier work completed.\n";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// Reads Claude Code stream-json. The last result event decides success. A result
// while background tasks (Monitor, background shells) still run is not final:
// Claude answers again when they finish.
export class ClaudeTurn {
  text?: string;
  failed = false;
  completed = false;
  background = 0;
  // Tokens the session sent with its latest model call, i.e. its current context size.
  contextTokens = 0;
  // Decided only at a result event: a task finishing between results means another result is coming.
  settled = false;
  ingest(value: unknown): string | undefined {
    const event = object(value);
    const usage = object(object(event.message).usage);
    if (event.type === "assistant" && Object.keys(usage).length)
      this.contextTokens = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
    if (event.type === "system" && event.subtype === "background_tasks_changed" && Array.isArray(event.tasks))
      this.background = event.tasks.length;
    if (event.type === "system" && event.subtype === "task_started")
      return `Background task started: ${String(event.description ?? event.task_id)}`;
    if (event.type === "system" && event.subtype === "task_notification")
      return `Background task ${String(event.status ?? "finished")}: ${String(event.summary ?? event.task_id)}`;
    if (event.type === "result") {
      this.completed = true;
      this.failed = event.is_error === true || event.subtype !== "success";
      this.text = !this.failed && typeof event.result === "string" ? event.result : undefined;
      this.settled = this.failed || this.background === 0;
      if (!this.settled) return "Waiting for background tasks before finishing the turn.";
      return undefined;
    }
    if (event.type !== "assistant") return undefined;
    const content = object(event.message).content;
    // Return assistant text for the pane log; never scrape it as the result.
    return Array.isArray(content)
      ? content.map(object).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n") || undefined
      : undefined;
  }
}
