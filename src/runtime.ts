import { apiRejection } from "./api-diagnostic.ts";
import { MAX_PROGRESS, validateProgress, type Progress } from "./progress.ts";
import { failureText } from "./recovery.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  "task-report",
  "task-runtime",
  "task-create",
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

export class Runtime implements ChatService {
  state: State;
  herdr: HerdrPort;
  config: RuntimeConfig;
  pollError?: string;
  runnerAt = 0;
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
        recoveryNote: job.recoveryNote,
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
      job.text = text;
      job.status = error ? "failed" : "completed";
      job.error = error;
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
  async assertAssigned(id: string): Promise<Record<string, unknown>> {
    const task = record(
      (await this.api(`/tasks/${encodeURIComponent(id)}`)).data,
    );
    if (
      task.assigneeId !== this.config.coworkerId ||
      ![
        "READY",
        "RUNNING",
        "INPUT_REQUIRED",
        "APPROVAL_REQUIRED",
        "AUTHENTICATION_REQUIRED",
        "AWAITING_EXTERNAL",
      ].includes(String(task.status))
    )
      throw new Error("Task is no longer assigned or executable");
    return task;
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
        const taskId = textField(event, "taskId");
        if (!this.state.get<boolean>("taskEvents", id)) {
          // Self-authored progress advances the cursor without an orchestration loop.
          if (event.coworkerId !== this.config.coworkerId) {
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
              !INERT_TASK_STATUSES.includes(String(task.status))
            ) {
              const owner = textField(task, typeof task.ownerId === "string" ? "ownerId" : "userId");
              let conversationId = this.state.get<string>("taskConversations", taskId);
              if (!conversationId) {
                conversationId = this.createConversation(owner, { taskId, ...(typeof task.organizationId === "string" ? { sokosumi_organization_id: task.organizationId } : {}) }).id;
                this.state.put("taskConversations", taskId, conversationId);
              }
              this.state.enqueue(
                {
                  conversationId,
                  kind: "task",
                  taskId,
                  input: `Sokosumi task event. Task: ${JSON.stringify(task)}\nEvent: ${JSON.stringify(event)}`,
                },
                `event:${id}`,
              );
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
        if (wasWorking && settled && resource.lastWake !== fingerprint)
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
        pollError: this.pollError,
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
      const status = typeof body.status === "string" ? body.status : undefined;
      const receipt = createHash("sha256").update(JSON.stringify([job.id, job.conversationId, job.taskId, status ?? null, content])).digest("hex");
      const previous = this.state.get<{ notificationId: string }>("taskReportReceipts", receipt);
      if (previous) return this.taskReportResult(previous.notificationId);
      const task = await this.assertAssigned(job.taskId);
      this.assertTaskOwner(task, this.taskConversation(job));
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
