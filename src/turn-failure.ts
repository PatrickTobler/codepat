// Inspect only top-level Codex failure events. Never copy arbitrary provider text,
// URLs, tool output, arguments or reasoning into durable/user-visible diagnostics.
const messages: Record<string, string> = {
  provider_policy: "Codex reported a provider safety-policy restriction.",
  provider_auth: "Codex reported an authentication failure.",
  provider_usage_limit: "Codex reported an account usage limit.",
  provider_rate_limit: "Codex reported a provider rate limit.",
  provider_context_limit: "Codex reported that the model context limit was exceeded.",
  provider_connection: "Codex reported a provider connection or stream failure.",
  provider_failure: "Codex reported a failed turn; no recognized safe diagnostic was available.",
};
export function protocolFailureText(kind: string): string | undefined { return Object.hasOwn(messages, kind) ? messages[kind] : undefined; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function classify(error: Record<string, unknown>): string {
  const code = error.codex_error_info ?? error.codexErrorInfo ?? error.code;
  const codes: Record<string, string> = {
    cyber_policy: "provider_policy", content_policy_violation: "provider_policy",
    Unauthorized: "provider_auth", unauthorized: "provider_auth",
    UsageLimitExceeded: "provider_usage_limit", usage_limit_exceeded: "provider_usage_limit",
    rate_limit_exceeded: "provider_rate_limit",
    ContextWindowExceeded: "provider_context_limit", context_length_exceeded: "provider_context_limit",
    ResponseStreamDisconnected: "provider_connection", ResponseStreamConnectionFailed: "provider_connection",
  };
  if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
  // exec JSONL can expose only a message, unlike the richer session record.
  // Match narrow known diagnostic phrases; do not forward any of that message.
  const message = typeof error.message === "string" ? error.message.slice(0, 4096) : "";
  if (/^This content was flagged for possible cybersecurity risk\./i.test(message)) return "provider_policy";
  if (/^(You've hit your usage limit|You have exceeded your usage limit)\b/i.test(message)) return "provider_usage_limit";
  if (/^Rate limit (reached|exceeded)\b/i.test(message)) return "provider_rate_limit";
  if (/^(Your input exceeds the context window|The model's maximum context length|Context window exceeded)\b/i.test(message)) return "provider_context_limit";
  if (/^(Stream disconnected before completion|Error connecting to provider)\b/i.test(message)) return "provider_connection";
  return "provider_failure";
}
export class TurnFailure {
  candidate?: string;
  terminal?: string;
  ingest(value: unknown): boolean {
    const event = object(value);
    if (event.type !== "error" && event.type !== "turn.failed") return false;
    const kind = classify(event.type === "turn.failed" ? object(event.error) : event);
    if (event.type === "turn.failed") this.terminal = kind;
    else this.candidate = kind;
    return true;
  }
  resolve(processFailure: string | undefined): string | undefined {
    // OS evidence wins; a transient error followed by success is not failure.
    if (processFailure && !["turn_exit_failure", "turn_empty_output"].includes(processFailure)) return processFailure;
    return this.terminal ?? (processFailure ? this.candidate ?? processFailure : undefined);
  }
}
