import { apiRejection } from "./api-diagnostic.ts";
import { hasLocalLinks, readableTaskText } from "./task-links.ts";
import { MAX_PROGRESS, validateProgress, type Progress } from "./progress.ts";
import { failureText } from "./recovery.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statfsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HerdrPort } from "./herdr.ts";
import type { ChatService } from "./http.ts";
import { inspectProject, pages } from "./projects.ts";
import {
  type Conversation,
  type Job,
  type Outbox,
  record,
  State,
  textField,
} from "./state.ts";

export interface RuntimeConfig {
  dataDir: string;
  cliPath: string;
  repo: string;
  apiUrl: string;
  apiKey?: string;
  coworkerId?: string;
  repositories?: Record<string, string>;
}
interface Scope {
  id: string;
  generation?: number;
}
class ApiError extends Error {
  status: number;
  rejectionKind?: string;
  constructor(status: number, message: string, rejectionKind?: string) {
    super(message);
    this.status = status;
    this.rejectionKind = rejectionKind;
  }
}
// Terminal task states never enqueue a coordinator turn.
const INERT_TASK_STATUSES = [
  "DRAFT",
  "QUEUED",
  "GRANT_PENDING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
];
const SCOPED_ACTIONS = [
  "progress",
  "projects",
  "project",
  "repositories",
  "instances",
  "task-status",
  "task-continue",
  "task-upload",
  "task-report",
  "task-runtime",
  "task-create",
  "task-input",
  "tasks",
  "task-consolidate",
];

interface TaskResource {
  kind: "herdr" | "external";
  resourceId: string;
  role: string;
  provider?: string;
  status?: string;
  revision?: number;
  seenWorking?: boolean;
  lastWake?: string;
  cycle?: number;
  attachedAt: number;
}
interface TaskRuntime {
  taskId: string;
  conversationId: string;
  resources: TaskResource[];
}

interface TaskContinuationReceipt {
  jobId: string;
  notificationId: string;
}

interface TaskInput {
  id: string;
  taskId: string;
  jobId: string;
  text: string;
  receivedAt: number;
  acknowledgement?: { outcome: "handled" | "relayed"; evidence: string; at: number };
}

interface TaskHealth {
  taskId: string;
  checkedAt: number;
  issue?: string;
  episode?: string;
  attempts: number;
  lastAttemptAt?: number;
  alerted?: boolean;
}

const TASK_FILE_MAX_BYTES = 104_857_600;
const TASK_FILE_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

export class Runtime implements ChatService {
  state: State;
  herdr: HerdrPort;
  config: RuntimeConfig;
  pollError?: string;
  reconciliationError?: string;
  runnerAt = 0;
  storageHealth(): { availableBytes: number; totalBytes: number; low: boolean } {
    const info = statfsSync(this.config.dataDir);
    const availableBytes = info.bavail * info.bsize;
    const totalBytes = info.blocks * info.bsize;
    return { availableBytes, totalBytes, low: availableBytes < Math.max(2 * 1024 ** 3, totalBytes * 0.1) };
  }
  constructor(state: State, herdr: HerdrPort, config: RuntimeConfig) {
    this.state = state;
    this.herdr = herdr;
    this.config = config;
    for (const job of state.all<Job>("jobs")) {
      if (
        !["chat", "task"].includes(String(job.kind)) &&
        ["queued", "in_progress"].includes(job.status)
      ) {
        state.put("jobs", job.id, {
          ...job,
          status: "failed",
          error: "legacy_workflow_retired",
          text: "This legacy CodePat workflow was retired during the direct-mode migration.",
        });
      }
    }
    // An interrupted send may already have reached Sokosumi. Never replay blindly.
    for (const item of state.all<Outbox>("outbox")) {
      if (item.status === "sending")
        state.put("outbox", item.id, { ...item, status: "uncertain" });
    }
  }
  scopedConfig(scope: Scope): string {
    const token = randomBytes(32).toString("hex");
    const key = createHash("sha256").update(token).digest("hex");
    this.state.put("scopes", key, scope);
    const master = record(
      JSON.parse(
        readFileSync(join(this.config.dataDir, "client.json"), "utf8"),
      ),
    );
    const dir = join(this.config.dataDir, "scopes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${key}.json`);
    writeFileSync(path, JSON.stringify({ url: master.url, token }), {
      mode: 0o600,
    });
    return path;
  }
  authorizeControl(
    token: string,
    action: string,
    body: Record<string, unknown>,
  ): boolean {
    const scope = this.state.get<Scope>(
      "scopes",
      createHash("sha256").update(token).digest("hex"),
    );
    if (!scope) return false;
    const job = this.getResponse(scope.id);
    return (
      body.jobId === scope.id &&
      job?.status === "in_progress" &&
      (scope.generation ?? 0) === (job.generation ?? 0) &&
      SCOPED_ACTIONS.includes(action)
    );
  }
  createConversation(
    owner: string,
    metadata: Record<string, string>,
  ): Conversation {
    const conversation = { id: `conv_${randomUUID()}`, owner, metadata };
    this.state.put("conversations", conversation.id, conversation);
    return conversation;
  }
  conversationOwner(id: string): string | undefined {
    return this.state.get<Conversation>("conversations", id)?.owner;
  }
  createResponse(
    owner: string,
    conversationId: string,
    input: string,
    idempotencyKey?: string,
  ): Job {
    if (this.conversationOwner(conversationId) !== owner)
      throw new Error("Conversation owner mismatch");
    const key = idempotencyKey
      ? `chat:${owner}:${conversationId}:${idempotencyKey}`
      : undefined;
    const job = this.state.enqueue(
      { conversationId, kind: "chat", input },
      key,
    );
    if (job.input !== input)
      throw new Error("Idempotency key already used with different input");
    return job;
  }
  findResponse(owner: string, conversationId: string, key: string): Job | undefined {
    if (this.conversationOwner(conversationId) !== owner) return undefined;
    const id = this.state.get<string>("dedupe", `chat:${owner}:${conversationId}:${key}`);
    return id ? this.getResponse(id) : undefined;
  }
  getResponse(id: string): Job | undefined {
    return this.state.get<Job>("jobs", id);
  }
  getProgress(id: string): Progress[] {
    this.job(id);
    return this.state.get<Progress[]>("progress", id) ?? [];
  }
  recordProgress(id: string, values: unknown): void {
    if (!Array.isArray(values) || values.length > MAX_PROGRESS) throw new Error("Invalid progress batch");
    const items = values.map(validateProgress);
    this.state.transaction(() => {
      const job = this.job(id);
      const stored = this.getProgress(id);
      for (const item of items) {
        const prior = stored.find(old => old.key === item.key);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(item)) throw new Error("Progress key conflict");
          continue;
        }
        if (job.status !== "in_progress") throw new Error("Job is not active");
        if (stored.length >= MAX_PROGRESS) break;
        stored.push(item);
      }
      this.state.put("progress", id, stored);
    });
  }
  async waitResponse(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = this.getResponse(id);
      if (!job || job.status === "completed" || job.status === "failed") return;
      await delay(150, undefined, { signal });
    }
  }
  job(id: string): Job {
    const job = this.getResponse(id);
    if (!job) throw new Error("Unknown job");
    return job;
  }
  taskConversation(job: Job): Conversation {
    const conversation = this.state.get<Conversation>("conversations", job.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    // Do not silently fall back to a personal workspace for legacy task records.
    textField(conversation.metadata, "sokosumi_organization_id");
    return conversation;
  }
  assertTaskOwner(task: Record<string, unknown>, conversation: Conversation): void {
    if ((task.ownerId ?? task.userId) !== conversation.owner ||
        task.organizationId !== conversation.metadata.sokosumi_organization_id)
      throw new Error("Task ownership or organization changed");
  }
  nextJob(runnerId?: string, protocol?: number): {
    job: Job;
    jobConfig: string;
    threadId?: string;
    context: unknown;
  } | null {
    this.runnerAt = Date.now();
    const active = this.state
      .all<Job>("jobs")
      .find((job) => job.status === "in_progress");
    if (
      active &&
      (!runnerId || this.state.get<string>("claims", active.id) !== runnerId)
    )
      return null;
    const queued = this.state
      .all<Job>("jobs")
      .filter((job) => job.status === "queued");
    const job = active ?? queued.find((job) => job.kind === "chat") ?? queued[0];
    if (!job) return null;
    // Prepare credentials before marking a claim; an I/O failure leaves the job queued.
    let jobConfig = this.state.get<string>("jobConfigs", job.id);
    if (!jobConfig) jobConfig = this.scopedConfig({ id: job.id, generation: job.generation ?? 0 });
    this.state.transaction(() => {
      job.status = "in_progress";
      job.submittedAt ??= Date.now();
      if (!active) { job.reservationProtocol = protocol; job.turnStarted = false; }
      this.state.put("jobs", job.id, job);
      this.state.put("jobConfigs", job.id, jobConfig);
      this.state.put("claims", job.id, runnerId ?? "test");
    });
    return {
      job,
      jobConfig,
      threadId: this.state.get<string>("threads", job.conversationId),
      context: {
        storage: this.storageHealth(),
        recoveryNote: job.recoveryNote,
        taskInputs: job.taskId ? this.state.all<TaskInput>("taskInputs").filter(input => input.taskId === job.taskId && !input.acknowledgement) : [],
        taskPolling: Boolean(this.config.apiKey && this.config.coworkerId),
        deliveryFailures: this.state
          .all<Outbox>("outbox")
          .filter(
            (item) =>
              Boolean(item.lastError) &&
              ["pending", "uncertain", "failed"].includes(item.status) &&
              item.conversationId === job.conversationId,
          )
          .map((item) => ({
            id: item.id,
            path: item.path,
            error: item.status === "uncertain" ? "delivery_uncertain" : "delivery_failed",
            attempts: item.attempts,
            httpStatus: item.httpStatus,
            rejectionKind: item.rejectionKind,
            reconciliationHttpStatus: item.reconciliationHttpStatus,
          })),
      },
    };
  }
  requeueChat(id: string, note: string): void {
    const job = this.job(id);
    if (job.kind !== "chat" || (job.recoveryAttempts ?? 0) >= 2) throw new Error("Chat recovery limit reached");
    job.status = "queued";
    job.text = "";
    job.error = undefined;
    job.generation = (job.generation ?? 0) + 1;
    job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1;
    job.recoveryNote = note;
    job.turnStarted = false;
    this.state.put("jobs", id, job);
    this.state.put("jobConfigs", id, null);
    this.state.put("claims", id, null);
  }
  recoverInterruptedJob(id: string, executionMayHaveStarted = false): void {
    const job = this.job(id);
    if (job.status !== "in_progress") return;
    // Called only after the supervisor proves the old runner is gone and the
    // old unit is inactive/failed/not-found. A stale heartbeat alone is insufficient.
    if (job.kind === "chat" && job.reservationProtocol === 1 && !job.turnStarted && !executionMayHaveStarted && (job.recoveryAttempts ?? 0) < 2) {
      this.state.transaction(() => this.requeueChat(id, "Recovered an unstarted reservation; no model process was authorized to launch."));
    } else this.completeJob(id, failureText("recovery_required"), "recovery_required");
  }
  completeJob(id: string, text: string, error?: string): void {
    const job = this.job(id);
    if (job.status === "completed" || job.status === "failed") return;
    if (job.status !== "in_progress") throw new Error("Job is not in progress");
    this.state.transaction(() => {
      if (error && !text.trim()) text = failureText(error);
      if (job.kind === "task") text = readableTaskText(text);
      job.text = text;
      job.status = error ? "failed" : "completed";
      job.error = error;
      job.completedAt = Date.now();
      this.state.put("jobs", id, job);
      // A task turn's final answer belongs on the Sokosumi task; an explicit
      // task-report in the same turn already delivered it.
      if (job.kind === "task" && job.taskId && text &&
          this.state.get<string>("jobTaskReport", job.id) !== text)
        this.reportTask(job.taskId, text, undefined, job.conversationId);
    });
  }
  outbox(path: string, body: Record<string, unknown>, conversationId?: string): string {
    const id = randomUUID();
    const item: Outbox = {
      id,
      path,
      body,
      status: "pending",
      createdAt: Date.now(),
      conversationId,
    };
    if (typeof body.comment === "string")
      item.body = {
        ...body,
        comment: `${body.comment}\n\n<!-- codepat:${id} -->`,
      };
    this.state.put("outbox", item.id, item);
    return id;
  }
  reportTask(id: string, comment: string, status?: string, conversationId?: string): string {
    const notificationId = this.outbox(
      `/tasks/${encodeURIComponent(id)}/events`,
      { comment, ...(status ? { status } : {}) },
      conversationId ?? this.state.get<string>("taskConversations", id),
    );
    if (status) {
      const item = this.state.get<Outbox>("outbox", notificationId)!;
      item.requestedTaskStatus = status;
      this.state.put("outbox", notificationId, item);
    }
    return notificationId;
  }
  async api(
    path: string,
    method = "GET",
    body?: unknown,
    contextHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.config.apiKey)
      throw new Error("Sokosumi API key is not configured");
    const response = await fetch(
      `${this.config.apiUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...contextHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new ApiError(
        response.status,
        `Sokosumi ${method} ${path.split("?")[0]} returned ${response.status}`,
        await apiRejection(response),
      );
    return record(await response.json());
  }
  async assertAssigned(id: string, allowTerminal = false): Promise<Record<string, unknown>> {
    const task = record(
      (await this.api(`/tasks/${encodeURIComponent(id)}`)).data,
    );
    if (
      task.assigneeId !== this.config.coworkerId ||
      (!allowTerminal && ![
        "READY",
        "RUNNING",
        "INPUT_REQUIRED",
        "APPROVAL_REQUIRED",
        "AUTHENTICATION_REQUIRED",
        "AWAITING_EXTERNAL",
      ].includes(String(task.status)))
    )
      throw new Error("Task is no longer assigned or executable");
    return task;
  }
  async uploadTaskFile(job: Job, sourcePath: string, requestedName?: string): Promise<Record<string, unknown>> {
    if (!job.taskId) throw new Error("No task in this request");
    const task = await this.assertAssigned(job.taskId, true);
    const conversation = this.taskConversation(job);
    this.assertTaskOwner(task, conversation);
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error("Task upload path must be a regular file");
    if (info.size < 1) throw new Error("Task upload file must not be empty");
    if (info.size > TASK_FILE_MAX_BYTES) throw new Error("Task upload file exceeds Sokosumi's 100 MiB limit");
    const name = requestedName?.trim() || basename(sourcePath);
    if (name !== basename(name) || name.length > 512) throw new Error("Task upload name must be a filename of at most 512 characters");
    const contentType = TASK_FILE_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
    const headers = this.contextHeaders(conversation);
    const filesPath = `/tasks/${encodeURIComponent(job.taskId)}/files`;
    const existing = (await this.api(filesPath, "GET", undefined, headers)).data;
    const existingIds = new Set(Array.isArray(existing) ? existing.map(item => String(record(item).id)) : []);
    const session = record((await this.api(filesPath, "POST", {
      filename: name,
      contentType,
      size: info.size,
    }, headers)).data);
    const uploadUrl = new URL(textField(session, "uploadUrl"));
    const apiUrl = new URL(this.config.apiUrl);
    const productionBlob = uploadUrl.protocol === "https:" &&
      (uploadUrl.hostname === "blob.vercel-storage.com" || uploadUrl.hostname.endsWith(".blob.vercel-storage.com"));
    const localTestUpload = ["127.0.0.1", "localhost", "::1"].includes(apiUrl.hostname) && uploadUrl.origin === apiUrl.origin;
    if (!productionBlob && !localTestUpload) throw new Error("Sokosumi returned an untrusted task upload URL");
    const uploadHeaders = record(session.headers);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": textField(uploadHeaders, "Content-Type") },
      body: await readFile(sourcePath),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Task file upload failed (${response.status})`);
    let blobUrl: string | undefined;
    try {
      const uploaded = record(await response.json());
      if (typeof uploaded.url === "string") blobUrl = uploaded.url;
    } catch {}
    for (let attempt = 0; attempt < 40; attempt++) {
      const listed = (await this.api(filesPath, "GET", undefined, headers)).data;
      const file = Array.isArray(listed)
        ? listed.map(record).find(item => !existingIds.has(String(item.id)) && item.name === name && item.size === info.size)
        : undefined;
      if (file && typeof file.fileUrl === "string") return file;
      await delay(250);
    }
    if (blobUrl) return { name, fileUrl: blobUrl, size: info.size, mimeType: contentType, registration: "pending" };
    throw new Error("Task file bytes were accepted but Sokosumi has not registered the file yet; inspect the task before retrying");
  }
  async recoverTask(id: string): Promise<Job> {
    const task = await this.assertAssigned(id);
    const owner = textField(task, typeof task.ownerId === "string" ? "ownerId" : "userId");
    const organizationId = textField(task, "organizationId");
    let conversationId = this.state.get<string>("taskConversations", id);
    if (!conversationId) {
      conversationId = this.createConversation(owner, { taskId: id, sokosumi_organization_id: organizationId }).id;
      this.state.put("taskConversations", id, conversationId);
    } else {
      const conversation = this.state.get<Conversation>("conversations", conversationId);
      if (!conversation || conversation.owner !== owner || conversation.metadata.sokosumi_organization_id !== organizationId)
        throw new Error("Task ownership or organization changed");
    }
    const events = Array.isArray(task.events) ? task.events.map(record) : [];
    const remoteRevision = events.length
      ? textField(events.at(-1)!, "id")
      : typeof task.updatedAt === "string" ? task.updatedAt : "initial";
    return this.state.enqueue({
      conversationId,
      kind: "task",
      taskId: id,
      input: `Recover this existing Sokosumi task. Inspect preserved work and attached resources before continuing. Task: ${JSON.stringify(task)}`,
    }, `task-recover:${id}:${remoteRevision}`);
  }
  async createTask(job: Job, body: Record<string, unknown>): Promise<{ task: Record<string, unknown>; job: Job }> {
    if (job.kind !== "chat") throw new Error("Tasks can only be created from a chat request");
    if (body.distinct !== true)
      throw new Error("Confirm this is a genuinely distinct deliverable; otherwise use task-continue on the existing task");
    const conversation = this.state.get<Conversation>("conversations", job.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const organizationId = textField(conversation.metadata, "sokosumi_organization_id");
    const projectId = textField(body, "projectId");
    const name = textField(body, "name");
    const description = textField(body, "description");
    if (name.length > 200 || description.length > 20_000) throw new Error("Task text is too long");
    const headers = this.contextHeaders(conversation);
    await inspectProject(this.api.bind(this), projectId, headers);
    const marker = `codepat-request:${job.id}`;
    const find = async () => (await pages(
      this.api.bind(this),
      `/tasks?scope=owned&projectId=${encodeURIComponent(projectId)}`,
      headers,
    )).filter(task => typeof task.description === "string" && task.description.includes(marker));
    let matches = await find();
    if (matches.length > 1) throw new Error("Multiple tasks match this request");
    let task = matches[0];
    if (!task) {
      try {
        task = record((await this.api("/tasks", "POST", {
          name,
          description: `${description}\n\n${marker}`,
          projectId,
          coworkerId: this.config.coworkerId,
          status: "READY",
        }, headers)).data);
      } catch (error) {
        matches = await find();
        if (matches.length !== 1) throw error;
        task = matches[0];
      }
    }
    if (task.projectId !== projectId || task.organizationId !== organizationId ||
        (task.ownerId ?? task.userId) !== conversation.owner ||
        (task.assigneeId ?? task.coworkerId) !== this.config.coworkerId)
      throw new Error("Created task identity or assignment does not match the request");
    const taskId = textField(task, "id");
    let conversationId = this.state.get<string>("taskConversations", taskId);
    if (!conversationId) {
      conversationId = this.createConversation(conversation.owner, { taskId, sokosumi_organization_id: organizationId }).id;
      this.state.put("taskConversations", taskId, conversationId);
    }
    const taskJob = this.state.enqueue({
      conversationId,
      kind: "task",
      taskId,
      input: `New Sokosumi task created from chat. Begin the work described by the task. Task: ${JSON.stringify(task)}`,
    }, `task-created:${taskId}`);
    return { task, job: taskJob };
  }
  async continueTask(job: Job, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (job.kind !== "chat") throw new Error("Existing tasks can only be continued from a chat request");
    const taskId = textField(body, "taskId");
    const canonicalId = this.state.get<string>("taskRedirects", taskId);
    if (canonicalId) throw new Error(`Task was consolidated; continue task ${canonicalId} instead`);
    const content = textField(body, "text");
    if (content.length > 20_000) throw new Error("Task continuation is too long");
    const receiptId = createHash("sha256")
      .update(JSON.stringify([job.id, taskId, content]))
      .digest("hex");
    const previous = this.state.get<TaskContinuationReceipt>("taskContinuationReceipts", receiptId);
    if (previous)
      return {
        job: this.job(previous.jobId),
        ...this.taskReportResult(previous.notificationId),
      };
    const requestingConversation = this.taskConversation(job);
    const headers = this.contextHeaders(requestingConversation);
    const task = record(
      (await this.api(`/tasks/${encodeURIComponent(taskId)}`, "GET", undefined, headers)).data,
    );
    this.assertTaskOwner(task, requestingConversation);
    if ((task.assigneeId ?? task.coworkerId) !== this.config.coworkerId)
      throw new Error("Task is no longer assigned to CodePat");
    const selectable = Array.isArray(task.selectableStatuses)
      ? task.selectableStatuses.map(String)
      : undefined;
    if (task.status !== "RUNNING" && selectable && !selectable.includes("RUNNING"))
      throw new Error("Task cannot transition to RUNNING");
    return this.state.transaction(() => {
      const raced = this.state.get<TaskContinuationReceipt>("taskContinuationReceipts", receiptId);
      if (raced)
        return {
          job: this.job(raced.jobId),
          ...this.taskReportResult(raced.notificationId),
        };
      let conversationId = this.state.get<string>("taskConversations", taskId);
      if (conversationId) {
        const existing = this.state.get<Conversation>("conversations", conversationId);
        if (!existing || existing.owner !== requestingConversation.owner ||
            existing.metadata.sokosumi_organization_id !== requestingConversation.metadata.sokosumi_organization_id)
          throw new Error("Task ownership or organization changed");
      } else {
        conversationId = this.createConversation(requestingConversation.owner, {
          taskId,
          sokosumi_organization_id: textField(requestingConversation.metadata, "sokosumi_organization_id"),
        }).id;
        this.state.put("taskConversations", taskId, conversationId);
      }
      const taskJob = this.state.enqueue({
        conversationId,
        kind: "task",
        taskId,
        input: `Continue this existing Sokosumi task from the user's chat instruction. Inspect its preserved checkout and attached runtime before acting. Task: ${JSON.stringify(task)}\nFollow-up: ${content}`,
      }, `task-continue:${receiptId}`);
      const notificationId = this.reportTask(
        taskId,
        content,
        task.status === "RUNNING" ? undefined : "RUNNING",
        conversationId,
      );
      this.state.put<TaskContinuationReceipt>("taskContinuationReceipts", receiptId, {
        jobId: taskJob.id,
        notificationId,
      });
      this.state.put<TaskInput>("taskInputs", `chat:${receiptId}`, {
        id: `chat:${receiptId}`, taskId, jobId: taskJob.id, text: content, receivedAt: Date.now(),
      });
      return {
        task,
        job: taskJob,
        ...this.taskReportResult(notificationId),
      };
    });
  }
  async consolidateTask(job: Job, body: Record<string, unknown>): Promise<unknown> {
    if (job.kind !== "chat") throw new Error("Task consolidation requires a chat request");
    const taskId = textField(body, "taskId");
    const duplicateId = textField(body, "duplicateId");
    const reason = textField(body, "text");
    if (taskId === duplicateId || reason.length > 2000) throw new Error("Invalid consolidation request");
    const conversation = this.taskConversation(job);
    const headers = this.contextHeaders(conversation);
    const tasks = await Promise.all([taskId, duplicateId].map(async id => {
      const task = record((await this.api(`/tasks/${encodeURIComponent(id)}`, "GET", undefined, headers)).data);
      this.assertTaskOwner(task, conversation);
      if ((task.assigneeId ?? task.coworkerId) !== this.config.coworkerId) throw new Error("Task is no longer assigned to CodePat");
      return task;
    }));
    if (tasks[0].projectId !== tasks[1].projectId) throw new Error("Tasks must belong to the same project");
    const key = `${taskId}:${duplicateId}`;
    const previous = this.state.get("taskConsolidations", key);
    if (previous) return previous;
    if (this.state.get("taskRedirects", taskId) || this.state.get("taskRedirects", duplicateId))
      throw new Error("Task already consolidated; use its canonical task");
    for (const [task, target] of [[tasks[0], "RUNNING"], [tasks[1], "CANCELED"]] as const) {
      if (Array.isArray(task.selectableStatuses) && task.status !== target && !task.selectableStatuses.includes(target))
        throw new Error(`Task cannot transition to ${target}`);
    }
    return this.state.transaction(() => {
      const raced = this.state.get("taskConsolidations", key);
      if (raced) return raced;
      const jobs = this.state.all<Job>("jobs");
      if (jobs.some(item => item.taskId === duplicateId && item.status === "in_progress"))
        throw new Error("Duplicate task has an active coordinator turn; wait for it to finish before consolidation");
      let conversationId = this.state.get<string>("taskConversations", taskId);
      if (!conversationId) {
        conversationId = this.createConversation(conversation.owner, { taskId, sokosumi_organization_id: textField(conversation.metadata, "sokosumi_organization_id") }).id;
        this.state.put("taskConversations", taskId, conversationId);
      }
      const canonical = this.state.get<TaskRuntime>("taskRuntimes", taskId) ?? { taskId, conversationId, resources: [] };
      const duplicate = this.state.get<TaskRuntime>("taskRuntimes", duplicateId);
      for (const resource of duplicate?.resources ?? []) {
        if (!canonical.resources.some(item => item.kind === resource.kind && item.resourceId === resource.resourceId)) canonical.resources.push(resource);
      }
      this.state.put("taskRuntimes", taskId, canonical);
      if (duplicate) this.state.put("taskRuntimes", duplicateId, { ...duplicate, resources: [] });
      for (const input of this.state.all<TaskInput>("taskInputs").filter(input => input.taskId === duplicateId && !input.acknowledgement))
        this.state.put("taskInputs", input.id, { ...input, taskId });
      const queued = jobs.filter(item => item.taskId === duplicateId && item.status === "queued");
      for (const item of queued) this.state.put("jobs", item.id, { ...item, status: "completed", completedAt: Date.now(), text: `Transferred to task ${taskId}` });
      const continuation = this.state.enqueue({ conversationId, kind: "task", taskId,
        input: `Task consolidation: ${duplicateId} is now tracked under ${taskId}. ${reason}\nInspect transferred resources and preserved work; do not start duplicate workers or repeat live actions. Original: ${JSON.stringify(tasks[0])}\nDuplicate: ${JSON.stringify(tasks[1])}\nTransferred queued instructions: ${JSON.stringify(queued.map(item => item.input))}`,
      }, `task-consolidation:${key}`);
      const notifications = [
        this.reportTask(taskId, `Continuing here with resources and pending instructions from duplicate task ${duplicateId}. ${reason}`, tasks[0].status === "RUNNING" ? undefined : "RUNNING", conversationId),
        this.reportTask(duplicateId, `Duplicate consolidated into task ${taskId}. Work is preserved and tracked there. ${reason}`, tasks[1].status === "CANCELED" ? undefined : "CANCELED", this.state.get<string>("taskConversations", duplicateId) ?? conversationId),
      ];
      const result = { taskId, duplicateId, jobId: continuation.id, notificationIds: notifications, delivery: "pending" };
      this.state.put("taskConsolidations", key, result);
      this.state.put("taskRedirects", duplicateId, taskId);
      return result;
    });
  }
  async pollTasks(): Promise<void> {
    if (!this.config.apiKey || !this.config.coworkerId) return;
    try {
      const cursor = this.state.get<string>("meta", "taskCursor");
      const response = await this.api(
        `/coworkers/me/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!Array.isArray(response.data))
        throw new Error("Invalid task event page");
      for (const raw of response.data) {
        const event = record(raw);
        const id = textField(event, "id");
        const sourceTaskId = textField(event, "taskId");
        const taskId = this.state.get<string>("taskRedirects", sourceTaskId) ?? sourceTaskId;
        if (!this.state.get<boolean>("taskEvents", id)) {
          // Self-authored progress advances the cursor without an orchestration loop.
          const actor = event.actor && typeof event.actor === "object" && !Array.isArray(event.actor)
            ? record(event.actor)
            : undefined;
          const selfAuthored = actor
            ? actor.type === "coworker" && actor.id === this.config.coworkerId
            : event.coworkerId === this.config.coworkerId;
          if (!selfAuthored) {
            const hasComment = typeof event.comment === "string" && Boolean(event.comment.trim());
            let task: Record<string, unknown> | undefined;
            try {
              task = record(
                (await this.api(`/tasks/${encodeURIComponent(taskId)}`)).data,
              );
            } catch (error) {
              if (!(error instanceof ApiError && [403, 404].includes(error.status)))
                throw error;
            }
            if (
              task &&
              task.assigneeId === this.config.coworkerId &&
              (hasComment || !INERT_TASK_STATUSES.includes(String(task.status)))
            ) {
              const eventTask = task;
              this.state.transaction(() => {
                const owner = textField(eventTask, typeof eventTask.ownerId === "string" ? "ownerId" : "userId");
                let conversationId = this.state.get<string>("taskConversations", taskId);
                if (!conversationId) {
                  conversationId = this.createConversation(owner, { taskId, ...(typeof eventTask.organizationId === "string" ? { sokosumi_organization_id: eventTask.organizationId } : {}) }).id;
                  this.state.put("taskConversations", taskId, conversationId);
                }
                const existing = this.state.get<Conversation>("conversations", conversationId);
                if (!existing || existing.owner !== owner || existing.metadata.sokosumi_organization_id !== eventTask.organizationId)
                  throw new Error("Task ownership or organization changed");
                const delivery = this.state.enqueue(
                  {
                    conversationId,
                    kind: "task",
                    taskId,
                    input: `Sokosumi task event. Task: ${JSON.stringify(task)}\nEvent: ${JSON.stringify(event)}`,
                  },
                  `event:${id}`,
                );
                if (hasComment && !this.state.get("taskInputs", id)) this.state.put<TaskInput>("taskInputs", id, {
                  id, taskId, jobId: delivery.id, text: String(event.comment), receivedAt: Date.now(),
                });
                this.state.put("taskEvents", id, true);
                this.state.put("meta", "taskCursor", id);
              });
            }
          }
          this.state.put("taskEvents", id, true);
        }
        this.state.put("meta", "taskCursor", id);
      }
      this.pollError = undefined;
    } catch (error) {
      this.pollError = String(error);
    }
  }
  async pollTaskRuntimes(): Promise<void> {
    const runtimes = this.state.all<TaskRuntime>("taskRuntimes");
    if (!runtimes.some(runtime => runtime.resources.some(resource => resource.kind === "herdr"))) return;
    const agents = await this.herdr.agents();
    const byPane = new Map(agents.map(agent => [agent.pane_id, agent]));
    for (const runtime of runtimes) {
      const transitions: string[] = [];
      for (const resource of runtime.resources) {
        if (resource.kind !== "herdr") continue;
        const agent = byPane.get(resource.resourceId);
        const status = agent?.agent_status ?? "missing";
        const revision = agent?.revision;
        const fingerprint = `${status}:${revision ?? ""}`;
        const wasWorking = resource.seenWorking || resource.status === "working";
        const settled = ["done", "idle", "blocked", "error", "missing"].includes(status);
        if (status === "working" && resource.status !== "working") {
          resource.cycle = (resource.cycle ?? 0) + 1;
          resource.lastWake = undefined;
        }
        const startupStalled = !wasWorking && (status !== "idle" || Date.now() - resource.attachedAt >= 60_000);
        if ((wasWorking || startupStalled) && settled && resource.lastWake !== fingerprint)
          transitions.push(`${resource.resourceId} is ${status} after work cycle ${resource.cycle ?? 1}`);
        resource.provider = agent?.agent ?? resource.provider;
        resource.seenWorking = wasWorking || status === "working";
        resource.status = status;
        resource.revision = revision;
        if (transitions.at(-1) === `${resource.resourceId} is ${status} after work cycle ${resource.cycle ?? 1}`)
          resource.lastWake = fingerprint;
      }
      if (transitions.length) {
        const key = createHash("sha256").update(JSON.stringify(transitions)).digest("hex");
        this.state.enqueue({
          conversationId: runtime.conversationId,
          kind: "task",
          taskId: runtime.taskId,
          input: `Attached task runtime changed state: ${transitions.join(", ")}. Inspect the resource output and continue or finish the task.`,
        }, `task-runtime:${runtime.taskId}:${key}`);
      }
      this.state.put("taskRuntimes", runtime.taskId, runtime);
    }
  }
  async reconcileTasks(now = Date.now()): Promise<void> {
    if (!this.config.apiKey || !this.config.coworkerId) return;
    const errors: string[] = [];
    for (const conversation of this.state.all<Conversation>("conversations")) {
      const taskId = conversation.metadata.taskId;
      if (!taskId || this.state.get<string>("taskConversations", taskId) !== conversation.id) continue;
      if (this.state.get("taskRedirects", taskId)) continue;
      try {
        const task = record((await this.api(`/tasks/${encodeURIComponent(taskId)}`, "GET", undefined, this.contextHeaders(conversation))).data);
        this.assertTaskOwner(task, conversation);
        const jobs = this.state.all<Job>("jobs").filter(job => job.taskId === taskId);
        const pendingInputs = this.state.all<TaskInput>("taskInputs").filter(input => input.taskId === taskId && !input.acknowledgement);
        const resources = this.state.get<TaskRuntime>("taskRuntimes", taskId)?.resources ?? [];
        const active = jobs.some(job => ["queued", "in_progress"].includes(job.status));
        const last = jobs.at(-1);
        const recent = last && now - (last.completedAt ?? last.submittedAt ?? last.createdAt) < 300_000;
        const supported = resources.some(resource => resource.kind === "external" || resource.status === "working");
        let issue: string | undefined;
        if ((task.assigneeId ?? task.coworkerId) === this.config.coworkerId && !active && !recent) {
          if (pendingInputs.length) issue = "Task instructions have no acknowledged disposition";
          else if (task.status === "RUNNING" && !supported) issue = "Running task has no working resource or queued continuation";
        }
        const previous = this.state.get<TaskHealth>("taskHealth", taskId);
        const episode = pendingInputs.length ? `input:${pendingInputs[0].id}` : jobs.filter(job => !job.input.startsWith("Task lifecycle check:")).at(-1)?.id ?? "initial";
        const health: TaskHealth = {
          taskId, checkedAt: now, issue, episode,
          attempts: previous?.episode === episode ? previous.attempts : 0,
          lastAttemptAt: previous?.episode === episode ? previous.lastAttemptAt : undefined,
          alerted: previous?.episode === episode ? previous.alerted : false,
        };
        if (issue && now - (health.lastAttemptAt ?? 0) >= 300_000) {
          this.state.transaction(() => {
            if (health.attempts < 2) {
              const attempt = health.attempts + 1;
              this.state.enqueue({
                conversationId: conversation.id, taskId, kind: "task",
                input: `Task lifecycle check: ${issue}. Inspect preserved output, checkout, task events and attached resources before taking action. Reconcile uncertain effects before retrying. Resolve startup blockers within existing authorization, relay pending instructions with task-input acknowledgement, or report the precise waiting state. Never infer completion from idle. Task: ${JSON.stringify(task)}`,
              }, `task-health:${taskId}:${episode}:${attempt}`);
              health.attempts = attempt;
              health.lastAttemptAt = now;
            } else if (!health.alerted) {
              this.reportTask(taskId, `CodePat could not resolve this lifecycle issue after two inspection turns: ${issue}. Preserved work remains available; this task needs operational attention.`, undefined, conversation.id);
              health.alerted = true;
            }
            this.state.put("taskHealth", taskId, health);
          });
        } else this.state.put("taskHealth", taskId, health);
      } catch (error) { errors.push(`${taskId}: ${String(error)}`); }
    }
    this.reconciliationError = errors.length ? errors.join("; ") : undefined;
  }
  contextHeaders(conversation: Conversation): Record<string, string> {
    return {
      "X-Context-User-Id": conversation.owner,
      ...(conversation.metadata.sokosumi_organization_id
        ? {
            "X-Context-Organization-Id":
              conversation.metadata.sokosumi_organization_id,
          }
        : {}),
    };
  }
  async outboxWasDelivered(item: Outbox): Promise<boolean> {
    const taskId = /^\/tasks\/([^/]+)\/events$/.exec(item.path)?.[1];
    if (!taskId) return false;
    const events = (await this.api(`/tasks/${taskId}/events`)).data;
    return (
      Array.isArray(events) &&
      events.some((raw) => {
        const event = record(raw);
        return (
          event.coworkerId === this.config.coworkerId &&
          event.comment === item.body.comment &&
          (!item.body.status || event.status === item.body.status)
        );
      })
    );
  }
  taskReportResult(notificationId: string) {
    const delivery = this.state.get<Outbox>("outbox", notificationId);
    return {
      ok: Boolean(delivery && ["pending", "sending", "sent"].includes(delivery.status)),
      notificationId,
      status: delivery?.status ?? "unknown",
      httpStatus: delivery?.httpStatus,
      rejectionKind: delivery?.rejectionKind,
      reconciliationHttpStatus: delivery?.reconciliationHttpStatus,
      blockedReason: delivery?.blockedReason,
      accepted: delivery?.status === "sent",
    };
  }
  private flushingOutbox = false;
  async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    this.flushingOutbox = true;
    try { await this.flushOutboxSerial(); } finally { this.flushingOutbox = false; }
  }
  private async flushOutboxSerial(): Promise<void> {
    if (!this.config.apiKey) return;
    for (const snapshot of this.state.all<Outbox>("outbox")) {
      const item = this.state.get<Outbox>("outbox", snapshot.id)!;
      if (
        !["pending", "uncertain"].includes(item.status) ||
        (item.retryAt ?? 0) > Date.now()
      )
        continue;
      const taskId = /^\/tasks\/([^/]+)\/events$/.exec(item.path)?.[1];
      let attemptedPost = false;
      try {
        const conversation = item.conversationId
          ? this.state.get<Conversation>("conversations", item.conversationId)
          : undefined;
        const headers = conversation ? this.contextHeaders(conversation) : {};
        if (item.status === "uncertain") {
          if (await this.outboxWasDelivered(item)) {
            item.status = "sent";
            item.lastError = undefined;
            this.state.put("outbox", item.id, item);
            continue;
          }
          throw new Error(
            "Delivery outcome is unconfirmed; inspect remote history before retrying",
          );
        }
        if ((item.attempts ?? 0) >= 5)
          throw new Error(
            "Delivery retry limit reached; inspect remote history before manual retry",
          );
        if (item.requestedTaskStatus && taskId) {
          const prior = this.state.all<Outbox>("outbox");
          const earlier = prior.slice(0, prior.findIndex((o) => o.id === item.id));
          if (earlier.some((o) => o.path === item.path && ["pending", "sending", "uncertain"].includes(o.status))) {
            item.blockedReason = "Prior task report has an unresolved delivery outcome";
            this.state.put("outbox", item.id, item);
            continue;
          }
          // Preflight a distinct, not-yet-accepted report. Never retry uncertain POSTs.
          const remote = record((await this.api(`/tasks/${taskId}`, "GET", undefined, headers)).data);
          if (conversation) {
            if (remote.assigneeId !== this.config.coworkerId ||
                (remote.ownerId ?? remote.userId) !== conversation.owner ||
                remote.organizationId !== conversation.metadata.sokosumi_organization_id)
              throw new Error("Task owner, organization or assignment changed before reporting");
          }
          if (item.commentOnly || remote.status === item.requestedTaskStatus) delete item.body.status;
          else item.body.status = item.requestedTaskStatus;
          item.blockedReason = undefined;
        }
        item.status = "sending";
        item.attempts = (item.attempts ?? 0) + 1;
        this.state.put("outbox", item.id, item);
        attemptedPost = true;
        await this.api(item.path, "POST", item.body);
        item.status = "sent";
        item.lastError = undefined;
        item.httpStatus = undefined;
        item.rejectionKind = undefined;
        item.reconciliationHttpStatus = undefined;
        item.blockedReason = undefined;
        item.retryAt = undefined;
      } catch (error) {
        if (attemptedPost) {
          item.httpStatus = error instanceof ApiError ? error.status : undefined;
          item.rejectionKind = error instanceof ApiError ? error.rejectionKind : undefined;
        } else {
          item.reconciliationHttpStatus = error instanceof ApiError ? error.status : undefined;
          item.blockedReason = "Delivery preflight or reconciliation failed; no new POST attempted";
        }
        if (item.status === "sending")
          item.status =
            error instanceof ApiError && error.status === 422 && error.rejectionKind === "same_status" &&
              item.requestedTaskStatus && typeof item.body.comment === "string"
              ? "pending"
              : error instanceof ApiError && error.status === 429
              ? "pending"
              : error instanceof ApiError &&
                  [400, 401, 403, 404, 422].includes(error.status)
                ? "failed"
                : "uncertain";
        item.lastError = String(error);
        if (error instanceof ApiError && error.status === 422 && error.rejectionKind === "same_status" && item.status === "pending" && item.requestedTaskStatus) {
          // The status-bearing write was explicitly rejected as redundant. Keep
          // the comment in the same durable receipt and retry only the safe
          // comment-only form after a fresh preflight; never replay an uncertain POST.
          delete item.body.status;
          item.commentOnly = true;
          item.retryAt = Date.now();
          item.lastError = "Status already current; comment-only delivery queued after confirmed rejection";
        } else {
          item.retryAt =
            Date.now() +
            Math.min(60_000, 2000 * 2 ** Math.min(item.attempts ?? 0, 5));
        }
      }
      this.state.put("outbox", item.id, item);
    }
  }
  async control(
    action: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (action === "next") return this.nextJob(textField(body, "runnerId"), body.protocol === 1 ? 1 : undefined);
    if (action === "heartbeat") {
      this.runnerAt = Date.now();
      return { ok: true };
    }
    if (action === "status")
      return {
        runnerAt: this.runnerAt,
        storage: this.storageHealth(),
        pollError: this.pollError,
        reconciliationError: this.reconciliationError,
        taskHealth: this.state.all<TaskHealth>("taskHealth").filter(task => task.issue),
        unacknowledgedInputs: this.state.all<TaskInput>("taskInputs").filter(input => !input.acknowledgement).map(input => ({ id: input.id, taskId: input.taskId, receivedAt: input.receivedAt })),
        taskPolling: Boolean(this.config.apiKey && this.config.coworkerId),
        uncertainNotifications: this.state
          .all<Outbox>("outbox")
          .filter((item) => item.status === "uncertain").length,
        deliveryFailures: this.state
          .all<Outbox>("outbox")
          .filter(
            (item) =>
              item.lastError &&
              ["pending", "uncertain", "failed"].includes(item.status),
          )
          .map((item) => ({
            id: item.id,
            status: item.status,
            error: item.lastError,
          })),
        pending: this.state
          .all<Job>("jobs")
          .filter((j) => j.status === "queued").length,
      };
    if (action === "task-recover")
      return { job: await this.recoverTask(textField(body, "taskId")) };
    const job = this.job(textField(body, "jobId"));
    if (action === "begin-turn") {
      if (job.status !== "in_progress" || this.state.get("claims", job.id) !== body.runnerId || job.turnStarted)
        throw new Error("Turn already started or claim invalid; reconcile instead of executing again");
      job.turnStarted = true;
      this.state.put("jobs", job.id, job);
      return { ok: true };
    }
    if (action === "reply") {
      if ((body.attempt ?? 0) !== (job.generation ?? 0)) throw new Error("Stale completion attempt");
      this.completeJob(
        job.id,
        typeof body.text === "string" ? body.text : "",
        typeof body.error === "string" ? body.error : undefined,
      );
      return { ok: true };
    }
    if (job.status !== "in_progress") throw new Error("Job is not active");
    if (action === "thread") {
      this.state.put("threads", job.conversationId, textField(body, "threadId"));
      return { ok: true };
    }
    if (action === "progress") {
      if (Object.keys(body).some(key => !["jobId", "items"].includes(key))) throw new Error("Unsupported progress arguments");
      this.recordProgress(job.id, body.items);
      return { ok: true };
    }
    if (action === "projects")
      return pages(this.api.bind(this), "/projects", this.contextHeaders(this.taskConversation(job)));
    if (action === "tasks") {
      const conversation = this.taskConversation(job);
      const tasks = await pages(this.api.bind(this), `/tasks?scope=owned&projectId=${encodeURIComponent(textField(body, "projectId"))}`, this.contextHeaders(conversation));
      return tasks.filter(task => (task.ownerId ?? task.userId) === conversation.owner && task.organizationId === conversation.metadata.sokosumi_organization_id)
        .map(task => ({ id: task.id, name: task.name, status: task.status, assigneeId: task.assigneeId }));
    }
    if (action === "project")
      return inspectProject(this.api.bind(this), textField(body, "projectId"), this.contextHeaders(this.taskConversation(job)));
    if (action === "repositories")
      return { default: this.config.repo, ...this.config.repositories };
    if (action === "instances") {
      const [workspaces, agents] = await Promise.all([
        this.herdr.call(["workspace", "list"]),
        this.herdr.agents(),
      ]);
      return { observedAt: Date.now(), workspaces, agents };
    }
    if (action === "task-status") {
      const requested = typeof body.taskId === "string" && body.taskId.trim()
        ? body.taskId.trim()
        : undefined;
      if (job.kind === "task" && requested && requested !== job.taskId)
        throw new Error("A task turn cannot inspect another task");
      const taskId = job.taskId ?? requested;
      if (!taskId) throw new Error("Supply the task ID to inspect from chat");
      const task = record(
        (await this.api(`/tasks/${encodeURIComponent(taskId)}`)).data,
      );
      this.assertTaskOwner(task, this.taskConversation(job));
      return task;
    }
    if (action === "task-continue") return this.continueTask(job, body);
    if (action === "task-consolidate") return this.consolidateTask(job, body);
    if (action === "task-input") {
      if (!job.taskId) throw new Error("No task in this request");
      const inputs = this.state.all<TaskInput>("taskInputs").filter(input => input.taskId === job.taskId);
      if (body.operation === "list") return inputs;
      if (body.operation !== "ack") throw new Error("Invalid task input operation");
      const input = inputs.find(input => input.id === body.inputId);
      if (!input) throw new Error("Input does not belong to this task");
      if (!["handled", "relayed"].includes(String(body.outcome))) throw new Error("Invalid acknowledgement outcome");
      const evidence = textField(body, "evidence");
      if (evidence.length > 2000) throw new Error("Acknowledgement is too long");
      if (!input.acknowledgement) {
        input.acknowledgement = { outcome: body.outcome as "handled" | "relayed", evidence, at: Date.now() };
        this.state.put("taskInputs", input.id, input);
      }
      return input;
    }
    if (action === "task-upload")
      return this.uploadTaskFile(
        job,
        textField(body, "path"),
        typeof body.name === "string" ? body.name : undefined,
      );
    if (action === "task-create") return this.createTask(job, body);
    if (action === "task-runtime") {
      if (!job.taskId) throw new Error("No task in this request");
      const operation = textField(body, "operation");
      const runtime = this.state.get<TaskRuntime>("taskRuntimes", job.taskId) ?? {
        taskId: job.taskId,
        conversationId: job.conversationId,
        resources: [],
      };
      if (operation === "list") return runtime;
      const kind = textField(body, "kind");
      if (!['herdr', 'external'].includes(kind)) throw new Error("Invalid task runtime kind");
      const resourceId = textField(body, "resourceId");
      if (operation === "detach") {
        runtime.resources = runtime.resources.filter(resource => !(resource.kind === kind && resource.resourceId === resourceId));
      } else if (operation === "attach") {
        const role = textField(body, "role");
        if (this.state.all<TaskRuntime>("taskRuntimes").some(other => other.taskId !== job.taskId && other.resources.some(resource => resource.kind === kind && resource.resourceId === resourceId)))
          throw new Error("Resource belongs to another task; consolidate the tasks or detach it there first");
        if (runtime.resources.some(resource => resource.kind === kind && resource.resourceId === resourceId))
          throw new Error("Task runtime resource is already attached");
        let agent: Awaited<ReturnType<HerdrPort["agents"]>>[number] | undefined;
        if (kind === "herdr") {
          agent = (await this.herdr.agents()).find(item => item.pane_id === resourceId);
          if (!agent) throw new Error("Herdr resource does not exist");
        }
        runtime.resources.push({
          kind: kind as TaskResource["kind"],
          resourceId,
          role,
          provider: agent?.agent,
          status: agent?.agent_status,
          revision: agent?.revision,
          seenWorking: agent?.agent_status === "working",
          cycle: agent?.agent_status === "working" ? 1 : 0,
          attachedAt: Date.now(),
        });
      } else throw new Error("Invalid task runtime operation");
      this.state.put("taskRuntimes", job.taskId, runtime);
      return runtime;
    }
    if (action === "task-report") {
      if (!job.taskId) throw new Error("No task in this request");
      const content = textField(body, "text");
      if (hasLocalLinks(content)) throw new Error("Upload local evidence with task-upload and use its fileUrl before reporting links");
      const status = typeof body.status === "string" ? body.status : undefined;
      const receipt = createHash("sha256").update(JSON.stringify([job.id, job.conversationId, job.taskId, status ?? null, content])).digest("hex");
      const previous = this.state.get<{ notificationId: string }>("taskReportReceipts", receipt);
      if (previous) return this.taskReportResult(previous.notificationId);
      const task = await this.assertAssigned(job.taskId, true);
      this.assertTaskOwner(task, this.taskConversation(job));
      if (status === "COMPLETED" && this.state.get<TaskRuntime>("taskRuntimes", job.taskId)?.resources.length)
        throw new Error("Review and retire attached task resources, then detach them before reporting COMPLETED");
      if (status === "COMPLETED" && this.state.all<TaskInput>("taskInputs").some(input => input.taskId === job.taskId && !input.acknowledgement))
        throw new Error("Acknowledge the disposition of pending task inputs before reporting COMPLETED");
      if (
        status &&
        ![
          "RUNNING",
          "INPUT_REQUIRED",
          "APPROVAL_REQUIRED",
          "COMPLETED",
          "FAILED",
          "AWAITING_EXTERNAL",
        ].includes(status)
      )
        throw new Error("Invalid task status");
      return this.state.transaction(() => {
        // Recheck after the asynchronous ownership read: concurrent lost-ack retries
        // must reserve the same delivery, including when the first outcome is uncertain.
        const raced = this.state.get<{ notificationId: string }>("taskReportReceipts", receipt);
        if (raced) return this.taskReportResult(raced.notificationId);
        const notificationId = this.reportTask(
          job.taskId!,
          content,
          status === task.status ? undefined : status,
          job.conversationId,
        );
        if (status) {
          const delivery = this.state.get<Outbox>("outbox", notificationId)!;
          delivery.requestedTaskStatus = status;
          this.state.put("outbox", notificationId, delivery);
        }
        this.state.put("taskReportReceipts", receipt, { notificationId });
        this.state.put("jobTaskReport", job.id, content);
        return this.taskReportResult(notificationId);
      });
    }
    throw new Error("Unknown action");
  }
}
