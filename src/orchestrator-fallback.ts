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
  return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", ...session];
}
export const FALLBACK_NOTE =
  "Codex is unavailable for this turn, so you are running as Claude Code in its place. Earlier Codex conversation history is not available to you. Inspect the live repository, task and Herdr state before acting, and do not assume earlier work completed.\n";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// Reads Claude Code stream-json. Only the final result event decides success.
export class ClaudeTurn {
  text?: string;
  failed = false;
  completed = false;
  ingest(value: unknown): string | undefined {
    const event = object(value);
    if (event.type === "result") {
      this.completed = true;
      this.failed = event.is_error === true || event.subtype !== "success";
      if (!this.failed && typeof event.result === "string") this.text = event.result;
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
