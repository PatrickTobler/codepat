import { dirname } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";

export const MAX_PROGRESS = 128;
export interface Progress { key: string; kind: "commentary" | "summary" | "activity"; text: string }
const labels: Record<string, string> = {
  command_execution: "Running a command", file_change: "Updating files",
  mcp_tool_call: "Using a connected tool", web_search: "Searching the web",
  todo_list: "Updating the plan",
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function validateProgress(value: unknown): Progress {
  const item = object(value);
  if (Object.keys(item).some(key => !["key", "kind", "text"].includes(key)) ||
      typeof item.key !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(item.key) ||
      !["commentary", "summary", "activity"].includes(String(item.kind)) ||
      typeof item.text !== "string" || !item.text.trim() || item.text.length > 1000)
    throw new Error("Invalid public progress item");
  return item as unknown as Progress;
}

// Pinned to Codex exec JSONL 0.154: ReasoningItem.text is explicitly built
// from ThreadItem::Reasoning.summary, NOT raw reasoning. Other protocols fail closed.
export class CodexProgress {
  private pending?: Progress;
  private seen = new Set<string>();
  private emit: (item: Progress) => void;
  private summaries: boolean;
  constructor(emit: (item: Progress) => void, summaries = false) { this.emit = emit; this.summaries = summaries; }
  ingest(value: unknown): void {
    const event = object(value);
    if (!["item.started", "item.completed"].includes(String(event.type))) return;
    const item = object(event.item);
    if (typeof item.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(item.id)) return;
    const type = String(item.type);
    const key = `${item.id}:${event.type}`;
    if (this.seen.has(key) || this.seen.size >= 2048) return;
    this.seen.add(key);
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
    const flush = () => { if (this.pending) this.emit(this.pending); this.pending = undefined; };
    if (type === "agent_message" && event.type === "item.completed") {
      // Unknown/raw phases are never public. Exec 0.154 omits phase, so hold
      // its last message until subsequent public work establishes commentary.
      if (item.phase !== undefined && !["commentary", "final_answer"].includes(String(item.phase))) return;
      if (item.phase === "final_answer") { flush(); return; }
      flush();
      if (text) {
        const progress: Progress = { key, kind: "commentary", text };
        if (item.phase === "commentary") this.emit(progress);
        else this.pending = progress;
      }
    } else if (labels[type]) {
      flush();
      this.emit({ key, kind: "activity", text: `${labels[type]}${event.type === "item.completed" ? " — finished" : "…"}` });
    } else if (this.summaries && type === "reasoning" && event.type === "item.completed" && text) {
      // Explicit summary only; never forward reasoning.* / analysis / raw events.
      this.emit({ key, kind: "summary", text });
    }
  }
  finish(): void { this.pending = undefined; }
}

// Only projected public text reaches disk or control. Bounded independently of
// network speed; an interrupted runner leaves this journal for bridge recovery.
export class ProgressJournal {
  items: Progress[];
  path: string;
  constructor(path: string) {
    this.path = path;
    this.items = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    if (!Array.isArray(this.items) || this.items.length > MAX_PROGRESS) throw new Error("Invalid progress journal");
    this.items = this.items.map(validateProgress);
  }
  append(item: Progress): void {
    validateProgress(item);
    if (this.items.some(old => old.key === item.key) || this.items.length >= MAX_PROGRESS) return;
    this.items.push(item);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.items), { mode: 0o600 });
    const file = openSync(`${this.path}.tmp`, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(`${this.path}.tmp`, this.path);
    const directory = openSync(dirname(this.path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
