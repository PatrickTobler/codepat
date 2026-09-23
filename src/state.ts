import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Job {
  id: string;
  conversationId: string;
  kind: "chat" | "task" | "worker" | "review" | "incident";
  incidentIds?: string[];
  reviewOwner?: string;
  reviewOrganization?: string;
  reviewFingerprint?: string;
  input: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  text: string;
  error?: string;
  taskId?: string;
  workerId?: string;
  createdAt: number;
  submittedAt?: number;
  generation?: number;
  recoveryAttempts?: number;
  recoveryNote?: string;
  reservationProtocol?: number;
  turnStarted?: boolean;
}
export interface Conversation {
  id: string;
  owner: string;
  metadata: Record<string, string>;
}
export type WorkerKind = "codex" | "claude" | "grok";
export interface Worker {
  kind?: WorkerKind;
  id: string;
  name: string;
  prompt: string;
  repo: string;
  worktree: string;
  branch: string;
  baseBranch?: string;
  baseCommit?: string;
  setupInstructions?: string;
  recoveryAttempts?: number;
  recoveryHold?: boolean;
  holdId?: string;
  nextRecoveryAt?: number;
  taskId?: string;
  taskUrl?: string;
  projectId?: string;
  projectUnconfirmed?: boolean;
  conversationId: string;
  paneId?: string;
  idleSince?: number;
  archivedAt?: number;
  sessionId?: string;
  sessionEvidenceReference?: string;
  recoveryEpoch?: number;
  archiveRequestedAt?: number;
  state: string;
  result?: string;
  priorResult?: string;
  generation?: number;
  error?: string;
  observedAt: number;
  createdAt: number;
  routineApproval?: { receiptId: string; generation: number; paneId: string; actionDigest: string; status: "sending" | "accepted" | "uncertain"; at: number };
}
export interface Delivery {
  blockedReason?: string;
  recoveryNotice?: boolean;
  id: string;
  workerId: string;
  text: string;
  status: "queued" | "sending" | "sent" | "uncertain" | "superseded";
  createdAt: number;
}
export interface Outbox {
  commentOnly?: boolean;
  requestedTaskStatus?: string;
  reconciliationHttpStatus?: number;
  blockedReason?: string;
  httpStatus?: number;
  rejectionKind?: string;
  incidentIds?: string[];
  reviewNotification?: boolean;
  id: string;
  path: string;
  body: Record<string, unknown>;
  status:
    | "pending"
    | "sending"
    | "sent"
    | "uncertain"
    | "superseded"
    | "failed";
  attempts?: number;
  retryAt?: number;
  lastError?: string;
  createdAt?: number;
  conversationId?: string;
}

// SQLite owns durability and uniqueness; all writes are synchronous and short.
export class State {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id))",
    );
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => JSON.parse(String(row.value)));
  }
  put<T>(kind: string, id: string, value: T): void {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
  }
  transaction<T>(action: () => T): T {
    if (this.transactionDepth > 0) return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  enqueue(
    input: Omit<Job, "id" | "status" | "text" | "createdAt">,
    key?: string,
  ): Job {
    return this.transaction(() => {
      const prior = key ? this.get<string>("dedupe", key) : undefined;
      if (prior) {
        const job = this.get<Job>("jobs", prior);
        if (!job) throw new Error("Missing deduplicated job");
        return job;
      }
      const job: Job = {
        ...input,
        id: `resp_${randomUUID()}`,
        status: "queued",
        text: "",
        createdAt: Date.now(),
      };
      this.put("jobs", job.id, job);
      if (key) this.put("dedupe", key, job.id);
      return job;
    });
  }
  close(): void {
    this.db.close();
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function textField(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || !text.trim())
    throw new Error(`Missing ${key}`);
  return text;
}
