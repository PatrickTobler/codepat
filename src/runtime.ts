import { apiRejection } from "./api-diagnostic.ts";
import { Incidents, noticeText, safeCause, causeText, type Incident, type NoticeKind } from "./incidents.ts";
import { MAX_PROGRESS, validateProgress, type Progress } from "./progress.ts";
import { Reviews, reviewInterval, type ReviewWork } from "./review.ts";
import { failureText } from "./recovery.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contacts, type DirectSend } from "./contacts.ts";
import { type Agent, type HerdrPort, paneFrom } from "./herdr.ts";
import type { ChatService } from "./http.ts";
import { inspectProject, pages, projectId } from "./projects.ts";
import { prepareRepository } from "./repository.ts";
import {
  type Conversation,
  type Delivery,
  type Job,
  type Outbox,
  record,
  State,
  textField,
  type Worker,
} from "./state.ts";

export interface RuntimeConfig {
  dataDir: string;
  cliPath: string;
  repo: string;
  apiUrl: string;
  apiKey?: string;
  coworkerId?: string;
  workerIdleMs?: number;
  reviewIntervalMs?: number;
  repositories?: Record<string, string>;
  contactAccountsFile?: string;
}
interface Scope {
  kind: "job" | "worker";
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
export class Runtime implements ChatService {
  state: State;
  herdr: HerdrPort;
  config: RuntimeConfig;
  monitorAt = 0;
  monitorError?: string;
  pollError?: string;
  runnerAt = 0;
  reviews: Reviews;
  workerOperations = new Set<string>();
  contacts: Contacts;
  incidents: Incidents;
  constructor(state: State, herdr: HerdrPort, config: RuntimeConfig) {
    this.state = state;
    this.herdr = herdr;
    this.config = config;
    this.contacts = new Contacts(state, config);
    this.incidents = new Incidents(state);

    this.reviews = new Reviews(state, reviewInterval(config.reviewIntervalMs));
    // An interrupted send may already have reached the recipient. Never replay blindly.
    for (const item of state.all<Delivery>("deliveries")) {
      if (item.status === "sending")
        state.put("deliveries", item.id, { ...item, status: "uncertain" });
    }
    for (const item of state.all<Outbox>("outbox")) {
      if (item.status === "sending")
        state.put("outbox", item.id, { ...item, status: "uncertain" });
    }
    for (const worker of state.all<Worker>("workers")) {
      if (worker.state === "starting")
        state.put("workers", worker.id, { ...worker, state: "launch_failed" });
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
    if (scope.kind === "worker") {
      const worker = this.state.get<Worker>("workers", scope.id);
      return (
        action === "worker-result" &&
        body.workerId === scope.id &&
        worker?.generation === scope.generation
      );
    }
    return (
      body.jobId === scope.id &&
      this.getResponse(scope.id)?.status === "in_progress" &&
      (scope.generation ?? 0) === (this.getResponse(scope.id)?.generation ?? 0) &&
      [
        "workers",
        "instances",
        "repositories",
        "progress",
        "contacts",
        "dm-send",
        "dm-status",
        "dm-retry",

        "recover-chat",
        "incident-report",
        "review-status",
        "review-work",
        "projects",
        "project",
        "start",
        "send",
        "resume",
        "read",
        "stop",
        "task-report",
      ].includes(action)
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
  ownsWorker(job: Job, worker: Worker): boolean {
    const requesting = this.state.get<Conversation>("conversations", job.conversationId);
    const owning = this.state.get<Conversation>("conversations", worker.conversationId);
    return Boolean(requesting && owning && requesting.owner === owning.owner &&
      (job.kind !== "review" || job.conversationId === worker.conversationId) &&
      requesting.metadata.sokosumi_organization_id === owning.metadata.sokosumi_organization_id);
  }
  workers(job?: Job): Worker[] {
    return this.state
      .all<Worker>("workers")
      .filter((worker) => !job || this.ownsWorker(job, worker));
  }
  async workerAgent(worker: Worker): Promise<Agent | undefined> {
    if (!worker.paneId) return undefined;
    const live = (await this.herdr.agents()).find(
      (agent) => agent.pane_id === worker.paneId,
    );
    if (live && (live.name !== worker.name || live.cwd !== worker.worktree))
      throw new Error(
        "Worker pane belongs to another agent; retained for inspection",
      );
    return live;
  }
  projectConversation(job: Job): Conversation {
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
  async inspectProject(job: Job, id: string) {
    return inspectProject(this.api.bind(this), id, this.contextHeaders(this.projectConversation(job)));
  }
  async startWorker(
    job: Job,
    prompt: string,
    key: string,
    options: { repository?: string; baseBranch?: string; kind?: string; projectId?: string } = {},
  ): Promise<Worker> {
    const { repository = "default", baseBranch, kind = "codex" } = options;
    if (kind !== "codex" && kind !== "claude")
      throw new Error("Unsupported worker kind. Available: codex, claude");
    // Stable operation key prevents duplicate workers when an orchestrator turn recovers.
    const lookup = `worker:${job.id}:${key}`;
    const oldId = this.state.get<string>("workerKeys", lookup);
    if (oldId) {
      const old = this.state.get<Worker>("workers", oldId);
      if (!old) throw new Error("Missing worker record");
      if (options.projectId !== undefined && options.projectId !== old.projectId)
        throw new Error("Stable operation already uses another project; reassign the existing task explicitly");
      return old;
    }
    let selectedProject = options.projectId;
    if (job.taskId) {
      const task = await this.assertAssigned(job.taskId);
      const conversation = this.projectConversation(job);
      this.assertTaskOwner(task, conversation);
      if (selectedProject !== undefined && selectedProject !== task.projectId)
        throw new Error("Existing task has a different project; reassign it with owner authentication first");
      selectedProject = typeof task.projectId === "string" ? task.projectId : undefined;
    } else {
      projectId(selectedProject);
    }
    if (selectedProject) await this.inspectProject(job, selectedProject);
    const id = randomUUID();
    const name = `cp-${id.slice(0, 12)}`;
    const selectedRepo =
      repository === "default"
        ? this.config.repo
        : (this.config.repositories?.[repository] ??
          (isAbsolute(repository) ? repository : undefined));
    if (!selectedRepo)
      throw new Error(
        "Use a repository shortcut or an absolute checkout path. Clone a requested remote repository first with Git.",
      );
    const repo = realpathSync(selectedRepo);
    const worktree = join(this.config.dataDir, "worktrees", id);
    const worker: Worker = {
      kind,
      id,
      name,
      prompt,
      repo,
      worktree,
      branch: `codepat/${id}`,
      baseBranch,
      conversationId: job.conversationId,
      taskId: job.taskId,
      projectId: selectedProject,
      state: "starting",
      createdAt: Date.now(),
      observedAt: Date.now(),
    };
    this.state.transaction(() => {
      this.state.put("workers", id, worker);
      this.state.put("workerKeys", lookup, id);
    });
    try {
      if (!worker.taskId) await this.createWorkerTask(worker, job, key);
      if (worker.taskId) await this.assertAssigned(worker.taskId);
      mkdirSync(join(this.config.dataDir, "worktrees"), { recursive: true });
      Object.assign(
        worker,
        await prepareRepository({
          repo,
          worktree,
          branch: worker.branch,
          baseBranch,
        }),
      );
      this.state.put("workers", worker.id, worker);
      await this.launchWorkerSession(worker);
      worker.state = "idle";
      this.state.put("workers", id, worker);
      if (worker.taskId)
        this.reportTask(
          worker.taskId,
          "Automated system status: worker started; the orchestrator will assess and report its results.",
          "RUNNING",
        );
      this.queueInstruction(
        worker,
        `You are a coding worker managed by CodePat. Work only in ${worktree}. Follow its repository instructions. Scope: ${prompt}\n\n${worker.setupInstructions ?? ""}\n\nSupplied attachment paths in this request may be read as input; keep edits in your worktree.\n\nOther workers run concurrently in separate worktrees. Preserve their work. Finish with a verified result and report it using: node ${JSON.stringify(this.config.cliPath)} worker-result ${id} --file /absolute/path/to/result.md\nThe bridge appends the scoped reporting credential for each instruction. Use that credential for the result command. Describe tests, changed files, blockers, and branch. CodePat is your only coordinator. Do not merge, deploy, or message users unless the task explicitly authorizes it. Never approve an interactive permission dialog on behalf of the user. Subsequent CodePat instructions may arrive while you work.`,
      );
    } catch (error) {
      worker.state = "launch_failed";
      worker.error = String(error);
      this.state.put("workers", id, worker);
      this.workerNotice(
        worker,
        "Worker launch needs attention. Inspect the existing pane/worktree before retrying; do not create a duplicate.",
      );
    }
    return worker;
  }
  async launchWorkerSession(worker: Worker, resume = false): Promise<void> {
    const workspace = this.state.get<string>("meta", "workspace");
    if (!workspace) throw new Error("CodePat workspace is not ready");
    if (!worker.paneId) {
      const result = await this.herdr.call([
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        worker.worktree,
        "--label",
        worker.name,
        "--no-focus",
      ]);
      worker.paneId = paneFrom(result);
      this.state.put("workers", worker.id, worker);
    }
    await this.herdr.call([
      "agent",
      "start",
      worker.name,
      "--kind",
      worker.kind ?? "codex",
      "--pane",
      worker.paneId,
      "--",
      ...(worker.kind === "claude"
        ? [
            ...(resume ? ["--continue"] : []),
            "--permission-mode",
            "acceptEdits",
          ]
        : [
            ...(resume ? ["resume", "--last"] : []),
            "-C",
            worker.worktree,
            "--no-alt-screen",
            "-s",
            "danger-full-access",
            "-a",
            "never",
          ]),
    ]);
    worker.archivedAt = undefined;
    worker.idleSince = undefined;
    this.state.put("workers", worker.id, worker);
  }
  workerHasPendingActivity(worker: Worker): boolean {
    return (
      this.state
        .all<Job>("jobs")
        .some(
          (job) =>
            job.conversationId === worker.conversationId &&
            ["queued", "in_progress"].includes(job.status),
        ) ||
      this.state
        .all<Delivery>("deliveries")
        .some(
          (delivery) =>
            delivery.workerId === worker.id &&
            !["sent", "superseded"].includes(delivery.status),
        ) ||
      this.state
        .all<Outbox>("outbox")
        .some(
          (item) =>
            worker.taskId &&
            item.path ===
              `/tasks/${encodeURIComponent(worker.taskId)}/events` &&
            !["sent", "superseded"].includes(item.status),
        )
    );
  }
  async reconcileArchive(worker: Worker): Promise<void> {
    if (!worker.archiveRequestedAt || !worker.paneId) return;
    const workspace = this.state.get<string>("meta", "workspace");
    if (!workspace) throw new Error("CodePat workspace is not ready");
    const result = await this.herdr.call([
      "pane",
      "list",
      "--workspace",
      workspace,
    ]);
    if (!Array.isArray(result.panes))
      throw new Error("Herdr returned no pane list");
    if (result.panes.some((pane) => record(pane).pane_id === worker.paneId))
      return;
    worker.paneId = undefined;
    worker.archivedAt = worker.archiveRequestedAt;
    worker.archiveRequestedAt = undefined;
    worker.idleSince = undefined;
    this.state.put("workers", worker.id, worker);
  }
  async cleanupWorkers(now = Date.now()): Promise<void> {
    const idleMs = this.config.workerIdleMs ?? 15 * 60_000;
    for (const snapshot of this.workers()) {
      if (this.workerOperations.has(snapshot.id)) continue;
      this.workerOperations.add(snapshot.id);
      const worker = this.state.get<Worker>("workers", snapshot.id)!;
      try {
        await this.reconcileArchive(worker);
        if (
          !worker.paneId ||
          !worker.result ||
          worker.state !== "completed" ||
          worker.idleSince === undefined ||
          now - worker.idleSince < idleMs ||
          this.workerHasPendingActivity(worker)
        )
          continue;
        const live = (await this.herdr.agents()).find(
          (agent) => agent.pane_id === worker.paneId,
        );
        if (
          !live ||
          live.name !== worker.name ||
          live.cwd !== worker.worktree ||
          !["idle", "done"].includes(live.agent_status) ||
          this.workerHasPendingActivity(worker)
        )
          continue;
        worker.archiveRequestedAt = now;
        this.state.put("workers", worker.id, worker);
        await this.herdr.call(["pane", "close", worker.paneId]);
        worker.paneId = undefined;
        worker.archivedAt = now;
        worker.archiveRequestedAt = undefined;
        worker.idleSince = undefined;
        this.state.put("workers", worker.id, worker);
      } finally {
        this.workerOperations.delete(worker.id);
      }
    }
  }
  async wakeWorker(worker: Worker): Promise<void> {
    await this.reconcileArchive(worker);
    if (
      !worker.archivedAt &&
      worker.result &&
      !(await this.workerAgent(worker))
    ) {
      // A completed process can disappear without passing through idle cleanup.
      // Retain its old shell and resume in a fresh owned pane.
      worker.paneId = undefined;
      worker.archivedAt = Date.now();
      this.state.put("workers", worker.id, worker);
    }
    if (!worker.archivedAt) return;
    await this.launchWorkerSession(worker, true);
    worker.state = "idle";
    this.state.put("workers", worker.id, worker);
  }
  async createWorkerTask(
    worker: Worker,
    job: Job,
    title: string,
  ): Promise<void> {
    if (worker.taskId) return;
    if (!this.config.coworkerId)
      throw new Error("CodePat coworker is not configured");
    const conversation = this.state.get<Conversation>(
      "conversations",
      job.conversationId,
    );
    if (!conversation) throw new Error("Conversation not found");
    const organizationId = textField(
      conversation.metadata,
      "sokosumi_organization_id",
    );
    // The worker record is reserved before POST. Never retry an ambiguous create.
    const task = record(
      (
        await this.api(
          "/tasks",
          "POST",
          {
            name: title.replaceAll("-", " ").slice(0, 120),
            description: `${worker.prompt}\n\nCodePat worker reference: ${worker.id}`,
            assigneeId: this.config.coworkerId,
            projectId: projectId(worker.projectId),
            status: "READY",
          },
          {
            "X-Context-User-Id": conversation.owner,
            "X-Context-Organization-Id": organizationId,
          },
        )
      ).data,
    );
    worker.taskId = textField(task, "id");
    worker.taskUrl = `https://app.sokosumi.com/tasks/${encodeURIComponent(worker.taskId)}`;
    this.state.transaction(() => {
      this.state.put("workers", worker.id, worker);
      this.state.put("taskConversations", worker.taskId!, job.conversationId);
    });
    if (task.projectId !== worker.projectId) {
      worker.projectUnconfirmed = true;
      this.state.put("workers", worker.id, worker);
      throw new Error("Created task did not retain projectId; reconcile the existing task before launch");
    }
    if (task.status !== "READY")
      throw new Error(
        `Task created but cannot start: ${String(task.status)}. ${worker.taskUrl}`,
      );
  }
  confirmWorkerProject(worker: Worker, task: Record<string, unknown>): void {
    if (worker.projectUnconfirmed && task.projectId !== worker.projectId)
      throw new Error("Task project is still unconfirmed; correct the existing task before recovery");
    worker.projectUnconfirmed = false;
    worker.projectId = typeof task.projectId === "string" ? task.projectId : undefined;
    this.state.put("workers", worker.id, worker);
  }
  async prepareFollowup(worker: Worker, instruction: string): Promise<void> {
    if (!worker.taskId) return;
    const eventPath = `/tasks/${encodeURIComponent(worker.taskId)}/events`;
    for (const item of this.state.all<Outbox>("outbox")) {
      if (item.path !== eventPath || item.body.status !== "COMPLETED") continue;
      if (item.status === "sending")
        throw new Error(
          "Task completion is in flight; retry the follow-up after it finishes",
        );
      if (item.status === "pending") {
        item.status = "superseded";
        this.state.put("outbox", item.id, item);
      }
    }
    const task = record(
      (await this.api(`/tasks/${encodeURIComponent(worker.taskId)}`)).data,
    );
    if (task.assigneeId !== this.config.coworkerId)
      throw new Error("Task is no longer assigned to CodePat");
    this.confirmWorkerProject(worker, task);
    if (task.status === "COMPLETED") {
      await this.api(
        `/tasks/${encodeURIComponent(worker.taskId)}/events`,
        "POST",
        {
          status: "RUNNING",
          comment: `Continuing existing worker with user instructions:\n${instruction}`,
        },
      );
    } else await this.assertAssigned(worker.taskId);
    this.state.put<ReviewWork>("reviewWork", worker.id, { workerId: worker.id, state: "pending", note: instruction.slice(0, 2000) });
    this.state.put("reviewTaskStatus", worker.taskId, "RUNNING");
  }
  queueInstruction(worker: Worker, text: string): Delivery {
    const item: Delivery = {
      id: randomUUID(),
      workerId: worker.id,
      text,
      status: "queued",
      createdAt: Date.now(),
    };
    this.state.put("deliveries", item.id, item);
    return item;
  }
  workerNotice(worker: Worker, message: string, noticeKind?: NoticeKind): void {
    if(noticeKind || ["blocked","missing","unknown","recovery_blocked","launch_failed"].includes(worker.state)){
      const c=this.state.get<Conversation>("conversations",worker.conversationId);
      if(c){
        if(noticeKind==="recovered" && !worker.recoveryHold && ["working","idle","done","completed"].includes(worker.state)){
          const episode=this.incidents.healthy(c,"worker:"+worker.id);
          this.incidents.record(c,{source:"worker",sourceId:"worker:"+worker.id+":recovered:"+episode,kind:"recovered",cause:"worker_recovered",workerId:worker.id,taskId:worker.taskId});
        } else this.workerFailure(c,worker);
      }
      return;
    }
    this.state.enqueue({
      conversationId: worker.conversationId,
      kind: "worker",
      taskId: worker.taskId,
      workerId: worker.id,
      input: `${message}\nWorker: ${worker.name} (${worker.id}). State: ${worker.state}. ${(worker.result ?? "").slice(0,16000)}`,
    });
  }
  async monitor(): Promise<void> {
    try {
      const agents = await this.herdr.agents();
      this.monitorAt = Date.now();
      this.monitorError = undefined;
      for (const worker of this.workers()) {
        if (
          !worker.paneId ||
          this.workerOperations.has(worker.id) ||
          ["launch_failed", "starting"].includes(worker.state)
        )
          continue;
        const live = agents.find((agent) => agent.pane_id === worker.paneId);
        const replaced =
          live && (live.name !== worker.name || live.cwd !== worker.worktree);
        const state = replaced
          ? "recovery_blocked"
          : ["stopped", "recovery_blocked"].includes(worker.state)
            ? worker.state
            : worker.result
              ? "completed"
              : (live?.agent_status ?? "missing");
        const previous = worker.state;
        worker.state = state;
        if (state === "blocked" || (previous === "blocked" && state !== "working")) worker.recoveryHold = true;
        else if (state === "working") worker.recoveryHold = false;
        if (replaced)
          worker.error =
            "Worker pane belongs to another agent; retained for inspection";
        worker.observedAt = Date.now();
        if (
          worker.result &&
          live &&
          ["idle", "done"].includes(live.agent_status) &&
          !this.workerHasPendingActivity(worker)
        )
          worker.idleSince ??= Date.now();
        else worker.idleSince = undefined;
        this.state.put("workers", worker.id, worker);
        const conversation=this.state.get<Conversation>("conversations",worker.conversationId);
        if(conversation && live && !replaced && !worker.recoveryHold && ["working","idle","done","completed"].includes(worker.state) && ["working","idle","done"].includes(live.agent_status))
          this.incidents.healthy(conversation,"worker:"+worker.id);
        if (
          state !== previous &&
          [
            "blocked",
            "done",
            "missing",
            "unknown",
            "recovery_blocked",
          ].includes(state)
        ) {
          this.workerNotice(
            worker,
            state === "done"
              ? "Worker is ready for input. This does not prove task completion; inspect output and request a structured result if needed."
              : `Worker changed from ${previous} to ${state}.`,
          );
        }
      }
      this.observerHealthy("monitor");
    } catch (error) {
      this.monitorError = String(error);
      this.captureIncidents();
    }
  }
  async recoverWorkers(now = Date.now()): Promise<void> {
    for (const snapshot of this.workers()) {
      if (
        !["missing", "launch_failed"].includes(snapshot.state) ||
        snapshot.result ||
        snapshot.archivedAt ||
        (snapshot.nextRecoveryAt ?? 0) > now ||
        this.workerOperations.has(snapshot.id)
      )
        continue;
      this.workerOperations.add(snapshot.id);
      const worker = this.state.get<Worker>("workers", snapshot.id)!;
      try {
        const uncertain = this.state.all<Delivery>("deliveries").some(item => item.workerId === worker.id && ["sending", "uncertain"].includes(item.status));
        if (uncertain || worker.recoveryHold) {
          worker.state = "recovery_blocked";
          this.state.put("workers", worker.id, worker);
          this.workerNotice(worker, "Recovery retained an uncertain instruction or human approval boundary. Reconcile it before explicitly resuming; no instruction was replayed.");
          continue;
        }
        if ((worker.recoveryAttempts ?? 0) >= 2 || !worker.taskId) {
          worker.state = "recovery_blocked";
          this.state.put("workers", worker.id, worker);
          this.workerNotice(
            worker,
            "Automatic recovery stopped. Inspect the task and retained worktree before retrying; do not create a duplicate task.",
          );
          continue;
        }
        worker.recoveryAttempts = (worker.recoveryAttempts ?? 0) + 1;
        worker.nextRecoveryAt = now + worker.recoveryAttempts * 30_000;
        this.state.put("workers", worker.id, worker);
        const task = await this.assertAssigned(worker.taskId);
        this.confirmWorkerProject(worker, task);
        if (!existsSync(worker.worktree)) {
          Object.assign(
            worker,
            await prepareRepository({
              repo: worker.repo,
              worktree: worker.worktree,
              branch: worker.branch,
              baseBranch: worker.baseBranch,
            }),
          );
          this.state.put("workers", worker.id, worker);
        }
        const workspace = this.state.get<string>("meta", "workspace");
        if (!workspace) throw new Error("CodePat workspace is not ready");
        const panes = await this.herdr.call([
          "pane",
          "list",
          "--workspace",
          workspace,
        ]);
        if (!Array.isArray(panes.panes))
          throw new Error("Herdr returned no pane list");
        const pane = panes.panes
          .map(record)
          .find((p) => p.pane_id === worker.paneId);
        const existingAgent = await this.workerAgent(worker);
        if (pane && !existingAgent) {
          const info = record(
            (
              await this.herdr.call([
                "pane",
                "process-info",
                "--pane",
                worker.paneId!,
              ])
            ).process_info,
          );
          const foreground = Array.isArray(info.foreground_processes)
            ? info.foreground_processes.map(record)
            : [];
          if (
            pane.cwd !== worker.worktree ||
            foreground.length !== 1 ||
            foreground[0].pid !== info.shell_pid
          )
            throw new Error(
              "Existing pane is not an idle shell in the worker worktree; retained for inspection",
            );
        } else if (!pane && !existingAgent) worker.paneId = undefined;
        if (!existingAgent)
          await this.launchWorkerSession(worker, (worker.generation ?? 0) > 0);
        const previous = this.state
          .all<Delivery>("deliveries")
          .filter(
            (item) =>
              item.workerId === worker.id && item.status !== "superseded",
          )
          .slice(-3);
        this.state.transaction(() => {
          for (const item of previous) {
            if (["queued", "uncertain"].includes(item.status)) {
              item.status = "superseded";
              this.state.put("deliveries", item.id, item);
            }
          }
          worker.state = "idle";
          worker.error = undefined;
          this.state.put("workers", worker.id, worker);
          this.queueInstruction(
            worker,
            `Recover the interrupted task in the same worktree and saved session. Inspect current files and prior actions before continuing; never repeat an external side effect without checking whether it already happened. Inspect existing PRs for the retained branch and reuse them; a missing local receipt is not proof that a send, task, worker or PR was never created. Preserve pending human approvals. Original task: ${worker.prompt}\n${worker.setupInstructions ?? ""}\nRecent instructions (historical context; reconcile completed parts):\n${previous.map((item) => item.text).join("\n\n")}\nFinish by reporting a structured result with the reporting command appended below.`,
          );
        });
        if (task.status === "READY")
          this.reportTask(
            worker.taskId,
            "Automated system status: existing worker session restored; task completion is not yet verified.",
            "RUNNING",
          );
        this.workerNotice(
          worker,
          `Recovered the interrupted worker in ${worker.paneId}; continuing the same task and worktree (attempt ${worker.recoveryAttempts}/2).`,
          "recovered",
        );
      } catch (error) {
        worker.error = String(error);
        if (error instanceof ApiError && [403, 404].includes(error.status))
          worker.state = "stopped";
        else
          worker.state =
            (worker.recoveryAttempts ?? 0) >= 2
              ? "recovery_blocked"
              : "missing";
        this.state.put("workers", worker.id, worker);
        if (["recovery_blocked", "stopped"].includes(worker.state))
          this.workerNotice(
            worker,
            `Recovery needs attention: ${worker.error}`,
            "blocked",
          );
      } finally {
        this.workerOperations.delete(worker.id);
      }
    }
  }
  async deliver(): Promise<void> {
    for (const item of this.state.all<Delivery>("deliveries")) {
      if (item.status !== "queued") continue;
      const worker = this.state.get<Worker>("workers", item.workerId);
      if (!worker?.paneId || this.workerOperations.has(worker.id)) continue;
      // Busy agents accept steering; blocked UIs require a human decision.
      if (!["idle", "done", "working", "completed"].includes(worker.state))
        continue;
      item.status = "sending";
      this.state.put("deliveries", item.id, item);
      this.workerOperations.add(worker.id);
      try {
        if (worker.taskId) await this.assertAssigned(worker.taskId);
        const live = await this.workerAgent(worker);
        if (!live)
          throw new Error(
            "Worker process is missing; recover before delivering instructions",
          );
        if (!["idle", "done", "working"].includes(live.agent_status)) {
          item.status = "queued";
          this.state.put("deliveries", item.id, item);
          continue;
        }
        const current = this.state.get<Worker>("workers", worker.id)!;
        current.generation = (current.generation ?? 0) + 1;
        current.result = undefined;
        current.state = "working";
        this.state.put("workers", current.id, current);
        const reportConfig = this.scopedConfig({
          kind: "worker",
          id: worker.id,
          generation: current.generation,
        });
        await this.herdr.prompt(
          worker.paneId,
          `${item.text}\n\nReport the result for this instruction with CODEPAT_CONFIG=${JSON.stringify(reportConfig)} node ${JSON.stringify(this.config.cliPath)} worker-result ${worker.id} --file /absolute/path/to/result.md. This replaces any earlier reporting credential.`,
        );
        item.status = "sent";
      } catch (error) {
        item.status = "uncertain";
        const c=this.state.get<Conversation>("conversations",worker.conversationId);
        if(c)this.incidents.record(c,{source:"delivery",sourceId:"instruction:"+item.id,kind:"blocked",cause:"delivery_uncertain",workerId:worker.id,taskId:worker.taskId});
      } finally {
        this.workerOperations.delete(worker.id);
      }
      this.state.put("deliveries", item.id, item);
    }
  }
  nextJob(runnerId?: string, protocol?: number): {
    job: Job;
    jobConfig: string;
    threadId?: string;
    context: unknown;
  } | null {
    this.runnerAt = Date.now();
    this.captureIncidents();
    this.incidents.schedule();
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
    const job =
      active ?? queued.find((job) => job.kind === "chat") ?? queued.find(job => job.kind === "incident") ?? queued.find(job => job.kind !== "review") ?? queued[0];
    if (!job) return null;
    if (!active && job.kind === "review" && !this.reviews.claim(job, Date.now())) return this.nextJob(runnerId, protocol);
    if (!active && job.kind === "incident" && !this.incidents.selected(job).length) {
      job.status="completed"; job.text=""; this.state.put("jobs",job.id,job); return this.nextJob(runnerId,protocol);
    }
    // Prepare credentials before marking a claim; an I/O failure leaves the job queued.
    let jobConfig = this.state.get<string>("jobConfigs", job.id);
    if (!jobConfig) jobConfig = this.scopedConfig({ kind: "job", id: job.id, generation: job.generation ?? 0 });
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
      threadId: ["review","incident"].includes(job.kind) ? undefined : this.state.get<string>("threads", job.conversationId),
      context: job.kind === "incident" ? {incidents:this.incidents.selected(job).map(i=>this.incidents.view(i)), instruction:"Notification-only turn; underlying work must not be replayed."} : job.kind === "review" ? {
        incidents: this.incidents.context(this.state.get<Conversation>("conversations",job.conversationId)!,true),
        contactPolicy: { taskCoordination: this.contacts.coordinationAllowed({ userId: this.conversationOwner(job.conversationId) ?? "", organizationId: this.state.get<Conversation>("conversations", job.conversationId)?.metadata.sokosumi_organization_id ?? "" }) },
        review: this.reviews.context(this.state.get<Conversation>("conversations", job.conversationId)!),
        instructions: "Metadata only. Use scoped read/workers for details as needed. Do not infer missing authorization.",
      } : {
        incidents: this.incidents.context(this.state.get<Conversation>("conversations",job.conversationId)!,true),
        workerKinds: ["codex", "claude"],
        contactPolicy: { taskCoordination: this.contacts.coordinationAllowed({ userId: this.conversationOwner(job.conversationId)!, organizationId: this.state.get<Conversation>("conversations", job.conversationId)?.metadata.sokosumi_organization_id ?? "" }) },
        directMessages: this.contacts.recent({
          userId: this.conversationOwner(job.conversationId) ?? "",
          organizationId: this.state.get<Conversation>("conversations", job.conversationId)?.metadata.sokosumi_organization_id ?? "",
        }),

        recoveryNote: job.recoveryNote,
        workers: this.workers(job).filter(w=>w.conversationId===job.conversationId).map(w=>({...w,error:w.error ? "Worker operation failed; inspect scoped evidence before retrying." : undefined})),
        deliveryProblems: this.state
          .all<Delivery>("deliveries")
          .filter(
            (item) =>
              !["sent", "superseded"].includes(item.status) &&
              this.workers(job).some((w) => w.id === item.workerId && w.conversationId===job.conversationId),
          ),
        uncertainNotifications: this.state
          .all<Outbox>("outbox")
          .filter((item) => item.status === "uncertain" && item.conversationId === job.conversationId).length,
        monitorAt: this.monitorAt,
        monitorError: this.monitorError ? "monitor_unavailable" : undefined,
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
  workerFailure(c:Conversation,worker:Worker): void {
    this.incidents.observe(c,"worker:"+worker.id,{source:"worker",kind:"blocked",cause:worker.state==="missing"||worker.state==="unknown"?"worker_missing":"worker_blocked",workerId:worker.id,taskId:worker.taskId});
  }
  observerHealthy(channel:"monitor"|"poll"): void {
    for(const c of this.state.all<Conversation>("conversations"))this.incidents.healthy(c,channel);
  }
  captureIncidents(): void {
    const conversations=this.state.all<Conversation>("conversations");
    for(const c of conversations){
      const workers=this.state.all<Worker>("workers").filter(w=>w.conversationId===c.id);
      for(const w of workers.filter(w=>w.recoveryHold || ["launch_failed","recovery_blocked","blocked","missing","unknown"].includes(w.state)))this.workerFailure(c,w);
      for(const d of this.state.all<Delivery>("deliveries").filter(d=>d.status==="uncertain" && workers.some(w=>w.id===d.workerId))){
        const w=workers.find(w=>w.id===d.workerId)!;
        this.incidents.record(c,{source:"delivery",sourceId:"instruction:"+d.id,kind:"blocked",cause:"delivery_uncertain",workerId:w.id,taskId:w.taskId});
      }
      for(const o of this.state.all<Outbox>("outbox").filter(o=>o.conversationId===c.id && (["failed","uncertain"].includes(o.status) || (o.status==="pending" && Boolean(o.lastError))))){
        // A notification cannot create another notification failure job recursively.
        if(o.incidentIds?.length)continue;
        const task=/^\/tasks\/([^/]+)\/events$/.exec(o.path)?.[1];
        this.incidents.record(c,{source:"delivery",sourceId:"outbox:"+o.id,kind:"blocked",cause:o.status==="uncertain"?"delivery_uncertain":"delivery_failed",httpStatus:o.httpStatus,rejectionKind:o.rejectionKind,taskId:task?decodeURIComponent(task):undefined});
      }
      for(const d of this.state.all<DirectSend>("directSends").filter(d=>d.conversationId===c.id && d.userId===c.owner && d.organizationId===c.metadata.sokosumi_organization_id && ["uncertain","failed"].includes(d.status)))
        this.incidents.record(c,{source:"delivery",sourceId:"direct:"+d.id,kind:"blocked",cause:d.status==="uncertain"?"delivery_uncertain":"delivery_failed"});
      if(workers.some(w=>!["completed","stopped"].includes(w.state))){
        if(this.monitorError)this.incidents.observe(c,"monitor",{source:"monitor",kind:"blocked",cause:"monitor_unavailable"});
        if(this.pollError)this.incidents.observe(c,"poll",{source:"monitor",kind:"blocked",cause:"monitor_unavailable"});
      }
    }
  }
  incidentNotice(job:Job, items:Incident[], kind:NoticeKind, text:string, automated=false): void {
    this.state.transaction(()=>{
      const c=this.state.get<Conversation>("conversations",job.conversationId)!;
      if(items.some(i=>!this.incidents.owns(i,c)))throw new Error("Incident scope changed");
      const content=noticeText(kind,text,items,automated);
      const ids:string[]=[];
      if(c.metadata.sokosumi_room_id || c.metadata.sokosumi_conversation_id)
        ids.push(this.outbox(`/chat-conversations/${encodeURIComponent(c.id)}/messages`,{content},c.id));
      else for(const taskId of new Set(items.flatMap(i=>i.taskId?[i.taskId]:[])))
        ids.push(this.outbox(`/tasks/${encodeURIComponent(taskId)}/events`,{comment:content},c.id));
      for(const id of ids){const o=this.state.get<Outbox>("outbox",id)!;o.incidentIds=items.map(i=>i.id);this.state.put("outbox",id,o);}
      if(!automated){
        const schedule=this.state.get<import("./review.ts").ReviewSchedule>("reviewSchedules",c.id);
        const evidence=this.reviews.evidence(c);
        // Do not suppress an unrelated unfinished stage merely because this batch
        // explained one blocker. Only match a wholly covered blocked snapshot.
        const covered=evidence.snapshot.workers.length>0 && evidence.snapshot.workers.every(w=>
          ["blocked","missing","unknown","recovery_blocked","launch_failed"].includes(w.state) && items.some(i=>i.workerId===w.id)) &&
          evidence.snapshot.deliveries.length===0 && evidence.snapshot.outbox.every(o=>{
            const full=this.state.get<Outbox>("outbox",o.id);return full?.reviewNotification || full?.incidentIds?.length;
          });
        if(schedule && covered){schedule.lastNotified=evidence.fingerprint;this.state.put("reviewSchedules",c.id,schedule);}
      }
      for(const i of items){
        if(automated)i.fallback=true;else i.reviewedAt=Date.now();
        i.notificationMissing=!ids.length;
        i.notificationIds=[...(i.notificationIds??[]),...ids];this.state.put("incidents",i.id,i);
      }
    });
  }
  completeJob(id: string, text: string, error?: string): void {
    const job = this.job(id);
    if (job.status === "completed" || job.status === "failed") return;
    if (job.status !== "in_progress") throw new Error("Job is not in progress");
    this.state.transaction(() => {
      if (error) {
        error=safeCause(error);
        const c=this.state.get<Conversation>("conversations",job.conversationId)!;
        if(job.kind==="incident") {
          const items=this.incidents.selected(job);
          for(const i of items){i.reviewFailure=error;this.state.put("incidents",i.id,i);}
          const fresh=items.filter(i=>!i.fallback);
          if(fresh.length) this.incidentNotice(job,fresh,"blocked", "The orchestrator could not explain this incident. "+causeText(error)+" The incident remains recorded for a later authorized turn; no failed operation was replayed.",true);
          text="";
        } else {
          const i=this.incidents.record(c,{source:"turn",sourceId:job.id+":"+(job.generation??0),kind:"failure",cause:error,taskId:job.taskId,workerId:job.workerId});
          // The synchronous request must terminate honestly even when its agent cannot run.
          // Background failures first go to an orchestrator notification turn.
          text=job.kind==="chat" ? noticeText("failure",causeText(error)+" The incident is retained for the orchestrator; no action was retried.",[i],true) : "";
          if(job.kind==="chat"){i.fallback=true;this.state.put("incidents",i.id,i);}
        }
      } else if(job.kind==="incident") {
        const items=this.incidents.selected(job);
        if(text.trim() && text.trim()!=="[NO_UPDATE]" && items.length) this.incidentNotice(job,items,items.every(i=>i.kind==="recovered")?"recovered":items.some(i=>i.kind==="blocked")?"blocked":"failure",text);
        else for(const i of items){i.reviewedAt=Date.now();this.state.put("incidents",i.id,i);}
        text=""; // The single correlated notice was queued above.
      }
      if(!error && job.kind!=="incident" && (job.recoveryAttempts??0)>0){
        const c=this.state.get<Conversation>("conversations",job.conversationId)!;
        this.incidents.record(c,{source:"turn",sourceId:job.id+":"+(job.generation??0)+":recovered",kind:"recovered",cause:"turn_recovered",taskId:job.taskId});
      }
      if (job.kind === "review") text = this.reviews.finish(job, text, error);
      job.text = text;
      job.status = error ? "failed" : "completed";
      job.error = error;
      this.state.put("jobs", id, job);
      if (job.kind !== "chat" && job.kind !== "incident" && text) {
        if (job.taskId && this.state.get<string>("jobTaskReport",job.id)!==text) this.reportTask(job.taskId, text, undefined, job.kind === "review");
        const conversation = this.state.get<Conversation>(
          "conversations",
          job.conversationId,
        );
        if (
          conversation &&
          (conversation.metadata.sokosumi_room_id ||
            conversation.metadata.sokosumi_conversation_id)
        )
          this.outbox(
            `/chat-conversations/${encodeURIComponent(conversation.id)}/messages`,
            { content: text },
            conversation.id,
            job.kind === "review",
          );
      }
    });
  }
  outbox(
    path: string,
    body: Record<string, unknown>,
    conversationId?: string,
    reviewNotification = false,
  ): string {
    const id = randomUUID();
    const item: Outbox = {
      id,
      path,
      body,
      status: "pending",
      createdAt: Date.now(),
      conversationId,
      ...(reviewNotification ? { reviewNotification: true } : {}),
    };
    if (typeof body.comment === "string")
      item.body = {
        ...body,
        comment: `${body.comment}\n\n<!-- codepat:${id} -->`,
      };
    this.state.put("outbox", item.id, item);
    return id;
  }
  reportTask(id: string, comment: string, status?: string, reviewNotification = false): string {
    const tracked=[...new Set(this.state.all<Worker>("workers").filter(w=>w.taskId===id).map(w=>w.conversationId))];
    return this.outbox(
      `/tasks/${encodeURIComponent(id)}/events`,
      {
        comment,
        ...(status ? { status } : {}),
      },
      this.state.get<string>("taskConversations", id) ?? (tracked.length===1 ? tracked[0] : undefined),
      reviewNotification,
    );
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
  async pauseTaskWorkers(taskId: string): Promise<void> {
    for (const worker of this.workers().filter(
      (w) =>
        w.taskId === taskId &&
        w.paneId &&
        !["stopped", "completed"].includes(w.state),
    )) {
      if (await this.workerAgent(worker))
        await this.herdr.call(["agent", "send-keys", worker.paneId!, "ctrl+c"]);
      worker.state = "stopped";
      worker.generation = (worker.generation ?? 0) + 1;
      this.state.put("workers", worker.id, worker);
      this.workerNotice(
        worker,
        "Worker paused because the task was canceled, reassigned, or access was removed.",
      );
    }
  }
  async reconcileTaskWorkers(): Promise<void> {
    const ids = new Set(
      this.workers()
        .filter(
          (w) =>
            w.taskId &&
            (!["stopped", "completed", "launch_failed"].includes(w.state) || this.state.get<ReviewWork>("reviewWork", w.id)?.state === "pending"),
        )
        .map((w) => w.taskId!),
    );
    for (const id of ids) {
      try {
        const task = record(
          (await this.api(`/tasks/${encodeURIComponent(id)}`)).data,
        );
        this.state.put("reviewTaskStatus", id, task.assigneeId === this.config.coworkerId ? String(task.status) : "REASSIGNED");
        if (
          task.assigneeId !== this.config.coworkerId ||
          [
            "DRAFT",
            "QUEUED",
            "GRANT_PENDING",
            "COMPLETED",
            "FAILED",
            "CANCELED",
          ].includes(String(task.status))
        )
          await this.pauseTaskWorkers(id);
      } catch (error) {
        if (error instanceof ApiError && [403, 404].includes(error.status))
          await this.pauseTaskWorkers(id);
        else throw error;
      }
    }
  }
  async pollTasks(): Promise<void> {
    if (!this.config.apiKey || !this.config.coworkerId) return;
    try {
      await this.reconcileTaskWorkers();
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
          let task: Record<string, unknown>;
          try {
            task = record(
              (await this.api(`/tasks/${encodeURIComponent(taskId)}`)).data,
            );
          } catch (error) {
            if (
              error instanceof ApiError &&
              [403, 404].includes(error.status)
            ) {
              await this.pauseTaskWorkers(taskId);
              this.state.put("taskEvents", id, true);
              this.state.put("meta", "taskCursor", id);
              continue;
            }
            throw error;
          }
          this.state.put("reviewTaskStatus", taskId, task.assigneeId === this.config.coworkerId ? String(task.status) : "REASSIGNED");
          if (
            task.assigneeId !== this.config.coworkerId ||
            task.status === "CANCELED"
          )
            await this.pauseTaskWorkers(taskId);
          if (
            task.assigneeId === this.config.coworkerId &&
            event.coworkerId !== this.config.coworkerId &&
            ![
              "DRAFT",
              "QUEUED",
              "GRANT_PENDING",
              "COMPLETED",
              "FAILED",
              "CANCELED",
            ].includes(String(task.status))
          ) {
            const owner = textField(task, typeof task.ownerId === "string" ? "ownerId" : "userId");
            let conversationId = this.state.get<string>(
              "taskConversations",
              taskId,
            );
            if (!conversationId) {
              conversationId = this.createConversation(owner, { taskId, ...(typeof task.organizationId === "string" ? { sokosumi_organization_id: task.organizationId } : {}) }).id;
              this.state.put("taskConversations", taskId, conversationId);
            }
            this.state.enqueue(
              {
                conversationId,
                kind: "task",
                taskId,
                input: `Sokosumi task event. Check existing workers before launching anything. Handle new instructions by relaying them to the existing worker. Task: ${JSON.stringify(task)}\nEvent: ${JSON.stringify(event)}`,
              },
              `event:${id}`,
            );
          }
          this.state.put("taskEvents", id, true);
        }
        this.state.put("meta", "taskCursor", id);
      }
      this.pollError = undefined;
      this.observerHealthy("poll");
    } catch (error) {
      this.pollError = String(error);
      this.captureIncidents();
    }
  }
  taskHasUnfinishedWork(taskId: string): boolean {
    const workers = this.workers().filter((worker) => worker.taskId === taskId);
    return (
      workers.some(
        (worker) => !worker.result || worker.state !== "completed" ||
          ["pending", "waiting"].includes(this.state.get<ReviewWork>("reviewWork", worker.id)?.state ?? ""),
      ) ||
      this.state
        .all<Delivery>("deliveries")
        .some(
          (delivery) =>
            ["queued", "sending", "uncertain"].includes(delivery.status) &&
            workers.some((worker) => worker.id === delivery.workerId),
        )
    );
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
  chatRoute(conversation: Conversation): {
    roomId: string;
    parentMessageId?: string;
  } {
    // Direct chats already supply the room ID. Thread/mention correlations are
    // message IDs: Core rejects them as rooms; never guess a different destination.
    const roomId =
      conversation.metadata.sokosumi_room_id ??
      conversation.metadata.sokosumi_conversation_id;
    if (!roomId) throw new Error("Conversation has no Sokosumi room reference");
    return {
      roomId,
      parentMessageId: conversation.metadata.sokosumi_room_id
        ? conversation.metadata.sokosumi_parent_message_id
        : undefined,
    };
  }
  async outboxWasDelivered(item: Outbox): Promise<boolean> {
    const taskId = /^\/tasks\/([^/]+)\/events$/.exec(item.path)?.[1];
    if (taskId) {
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
    // Coworker keys cannot read room history. An ambiguous POST stays uncertain
    // for operator reconciliation; blindly replaying it could duplicate a message.
    return false;
  }
  async flushOutbox(): Promise<void> {
    if (!this.config.apiKey) return;
    for (const snapshot of this.state.all<Outbox>("outbox")) {
      const item = this.state.get<Outbox>("outbox", snapshot.id)!;
      if (
        !["pending", "uncertain"].includes(item.status) ||
        (item.retryAt ?? 0) > Date.now()
      )
        continue;
      const taskId = /^\/tasks\/([^/]+)\/events$/.exec(item.path)?.[1];
      if (
        item.body.status === "COMPLETED" &&
        taskId &&
        this.taskHasUnfinishedWork(decodeURIComponent(taskId))
      ) {
        item.status = "superseded";
        this.state.put("outbox", item.id, item);
        continue;
      }
      try {
        const conversation = item.conversationId
          ? this.state.get<Conversation>("conversations", item.conversationId)
          : undefined;
        if(item.incidentIds?.length && (!conversation || item.incidentIds.some(id=>{
          const incident=this.state.get<Incident>("incidents",id);
          return !incident || !this.incidents.owns(incident,conversation);
        }))){
          item.status="failed";item.lastError="Incident destination scope changed; no send attempted";
          this.state.put("outbox",item.id,item);continue;
        }
        const headers = conversation ? this.contextHeaders(conversation) : {};
        if (item.path.startsWith("/chat-conversations/")) {
          if (!conversation) throw new Error("Chat conversation missing");
          const route = this.chatRoute(conversation);
          item.path = `/chats/rooms/${encodeURIComponent(route.roomId)}/messages`;
          item.body = {
            ...item.body,
            ...(route.parentMessageId
              ? { parentMessageId: route.parentMessageId }
              : {}),
          };
        }
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
        // A follow-up may have superseded completion while a remote read was pending.
        if (this.state.get<Outbox>("outbox", item.id)?.status === "superseded")
          continue;
        if (
          item.body.status === "COMPLETED" &&
          taskId &&
          this.taskHasUnfinishedWork(decodeURIComponent(taskId))
        ) {
          item.status = "superseded";
          this.state.put("outbox", item.id, item);
          continue;
        }
        item.status = "sending";
        item.attempts = (item.attempts ?? 0) + 1;
        this.state.put("outbox", item.id, item);
        await this.api(item.path, "POST", item.body, headers);
        if (taskId && typeof item.body.status === "string") this.state.put("reviewTaskStatus", decodeURIComponent(taskId), item.body.status);
        item.status = "sent";
        item.lastError = undefined;
        item.retryAt = undefined;
      } catch (error) {
        item.httpStatus=error instanceof ApiError ? error.status : undefined;
        item.rejectionKind=error instanceof ApiError ? error.rejectionKind : undefined;
        if (item.status === "sending")
          item.status =
            error instanceof ApiError && error.status === 429
              ? "pending"
              : error instanceof ApiError &&
                  [400, 401, 403, 404, 422].includes(error.status)
                ? "failed"
                : "uncertain";
        item.lastError =
          error instanceof ApiError && error.status === 404 && !taskId
            ? "Chat destination unavailable (thread/mention correlations are not room IDs). Results remain on the Sokosumi task; normal chat replies still work."
            : String(error);
        item.retryAt =
          Date.now() +
          Math.min(60_000, 2000 * 2 ** Math.min(item.attempts ?? 0, 5));
      }
      if (this.state.get<Outbox>("outbox", item.id)?.status !== "superseded")
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
        workers: this.workers(),
        monitorAt: this.monitorAt,
        monitorError: this.monitorError,
        pollError: this.pollError,
        runnerAt: this.runnerAt,
        taskPolling: Boolean(this.config.apiKey && this.config.coworkerId),
        periodicReview: { enabled: this.reviews.interval !== 0, intervalMs: this.reviews.interval },
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
    if (action === "worker-result") {
      const worker = this.state.get<Worker>(
        "workers",
        textField(body, "workerId"),
      );
      if (!worker) throw new Error("Unknown worker");
      if (worker.result === textField(body, "text")) return { ok: true };
      this.state.transaction(() => {
        worker.result = textField(body, "text");
        worker.recoveryAttempts = 0;
        worker.nextRecoveryAt = undefined;
        worker.state = "completed";
        this.state.put("workers", worker.id, worker);
        this.state.put<ReviewWork>("reviewWork", worker.id, { workerId: worker.id, state: "pending", note: "Assess the new result against the original authorized task; retain required remaining stages or record waiting/done." });
        this.workerNotice(
          worker,
          "Worker submitted a result. Review evidence and report to the user; do not equate a claim with verified completion.",
        );
      });
      return { ok: true };
    }
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
    if (job.kind === "incident" && !["progress","thread"].includes(action)) throw new Error("Incident notification turns cannot mutate or retry underlying work");
    if (job.kind === "review") {
      const c = this.state.get<Conversation>("conversations", job.conversationId);
      if (!c || c.owner !== job.reviewOwner || c.metadata.sokosumi_organization_id !== job.reviewOrganization) throw new Error("Periodic scope changed");
    }
    if (action === "incident-report") {
      const c=this.state.get<Conversation>("conversations",job.conversationId)!;
      const item=this.state.get<Incident>("incidents",textField(body,"incidentId"));
      if(!item || !this.incidents.owns(item,c)) throw new Error("Incident not owned by this conversation");
      const kind=textField(body,"kind");
      if(!["failure","blocked","recovered"].includes(kind)) throw new Error("Invalid notice kind");
      if(!item.reviewedAt) this.incidentNotice(job,[item],kind as NoticeKind,textField(body,"text"));
      return {ok:true,notificationIds:this.state.get<Incident>("incidents",item.id)?.notificationIds};
    }
    if (action === "progress") {
      if (Object.keys(body).some(key => !["jobId", "items"].includes(key))) throw new Error("Unsupported progress arguments");
      this.recordProgress(job.id, body.items);
      return { ok: true };
    }
    if (action === "recover-chat") {
      if (job.kind === "review") throw new Error("Periodic review cannot authorize recovery");
      const target = this.job(textField(body, "responseId"));
      const note = textField(body, "reconciliation");
      if (body.reconciled !== true || note.length > 10000 || target.conversationId !== job.conversationId ||
          target.kind !== "chat" || target.status !== "failed") throw new Error("Explicit reconciled recovery of an owned failed chat is required");
      const workerIds = new Set(this.workers(target).map(w => w.id));
      if (this.state.all<Delivery>("deliveries").some(d => workerIds.has(d.workerId) && ["sending", "uncertain"].includes(d.status)) ||
          this.state.all<Outbox>("outbox").some(o => o.conversationId === target.conversationId && ["sending", "uncertain"].includes(o.status)))
        throw new Error("Uncertain external effects must be reconciled before recovery");
      this.state.transaction(() => this.requeueChat(target.id, note));
      return { id: target.id, status: "queued" };
    }
    if (action === "review-status") return this.reviews.status(job.conversationId);
    if (action === "review-work") {
      const worker = this.state.get<Worker>("workers", textField(body, "workerId"));
      if (!worker || worker.conversationId !== job.conversationId || !this.ownsWorker(job, worker)) throw new Error("Review work must belong to this conversation");
      const prior = this.state.get<ReviewWork>("reviewWork", worker.id);
      if (job.kind === "review" && prior && prior.state !== "pending" && body.state === "pending") throw new Error("Periodic review cannot reopen waiting or completed work");
      const state = textField(body, "state"); const note = textField(body, "text");
      if (!["pending", "waiting", "done"].includes(state) || note.length > 2000) throw new Error("Invalid review work state or note");
      this.state.put("reviewWork", worker.id, { workerId: worker.id, state, note });
      return { ok: true };
    }
    if (job.kind === "review" && ["start", "recover-chat", "instances", "task-report"].includes(action)) throw new Error("Periodic reviews cannot create work, override recovery approval or post task transitions");
    if (action === "thread") {
      if (["review","incident"].includes(job.kind)) return { ok: true }; // Fresh bounded review context must not replace the user thread.
      this.state.put(
        "threads",
        job.conversationId,
        textField(body, "threadId"),
      );
      return { ok: true };
    }
    if (["contacts", "dm-send", "dm-status", "dm-retry"].includes(action)) {
      const allowed = action === "contacts" ? ["jobId", "query"]
        : action === "dm-send" ? ["jobId", "key", "query", "recipientId", "roomId", "text", "coordination"] : ["jobId", "key"];
      if (Object.keys(body).some(key => !allowed.includes(key)))
        throw new Error("Unsupported contact arguments; identity and credentials come from the active request");
      const conversation = this.projectConversation(job);
      const scope = { userId: conversation.owner, organizationId: textField(conversation.metadata, "sokosumi_organization_id"), conversationId: conversation.id };
      if (action === "contacts") return this.contacts.lookup(scope, textField(body, "query"));
      const key = textField(body, "key");
      if (action === "dm-status") return this.contacts.get(scope, key);
      if (job.kind === "review" && ["dm-send", "dm-retry"].includes(action)) {
        const purpose = action === "dm-send" ? body.coordination : this.contacts.get(scope, key).request.coordination;
        if (typeof purpose !== "string" || !purpose.trim() || !this.contacts.coordinationAllowed(scope))
          throw new Error("Periodic contact requires the scoped standing coordination preference and task purpose");
      }
      if (action === "dm-retry") return this.contacts.retry(scope, key);
      const queued = this.contacts.queue(scope, key, body);
      // Return a final local state when possible; intent is durable first. The
      // independent delivery loop also recovers queued work after disconnects.
      await this.contacts.deliverQueued(queued.id);
      return this.contacts.get(scope, key);
    }
    if (action === "projects")
      return pages(this.api.bind(this), "/projects", this.contextHeaders(this.projectConversation(job)));
    if (action === "project") return this.inspectProject(job, textField(body, "projectId"));
    if (action === "repositories")
      return { default: this.config.repo, ...this.config.repositories };
    if (action === "instances") {
      const [workspaces, agents] = await Promise.all([
        this.herdr.call(["workspace", "list"]),
        this.herdr.agents(),
      ]);
      return { observedAt: Date.now(), workspaces, agents };
    }
    if (action === "workers") return this.workers(job);
    if (action === "start")
      return this.startWorker(
        job,
        textField(body, "prompt"),
        textField(body, "key"),
        {
          repository:
            typeof body.repository === "string" ? body.repository : undefined,
          baseBranch:
            typeof body.baseBranch === "string" ? body.baseBranch : undefined,
          kind: typeof body.kind === "string" ? body.kind : undefined,
          projectId: body.projectId === undefined ? undefined : projectId(body.projectId),
        },
      );
    if (action === "task-report") {
      if (!job.taskId) throw new Error("No task in this request");
      const content = textField(body, "text");
      const status = typeof body.status === "string" ? body.status : undefined;
      const receipt = createHash("sha256").update(JSON.stringify([job.id,job.conversationId,job.taskId,status??null,content])).digest("hex");
      const previous = this.state.get<{notificationId:string}>("taskReportReceipts",receipt);
      if(previous) return {ok:true,...previous};
      const task = await this.assertAssigned(job.taskId);
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
      if (status === "COMPLETED" && this.taskHasUnfinishedWork(job.taskId))
        throw new Error(
          "Task still has unfinished workers; report progress with RUNNING instead",
        );
      const label=status==="FAILED" ? "failure" : ["INPUT_REQUIRED","APPROVAL_REQUIRED","AWAITING_EXTERNAL"].includes(status??"") ? "blocked" : undefined;
      return this.state.transaction(()=>{
        // Recheck after the asynchronous ownership read: concurrent lost-ack retries
        // must reserve the same delivery, including when the first outcome is uncertain.
        const previous=this.state.get<{notificationId:string}>("taskReportReceipts",receipt);
        if(previous)return {ok:true,...previous};
        const notificationId=this.reportTask(
          job.taskId!,
          label ? noticeText(label,content,[{taskId:job.taskId}]) : content,
          status === task.status ? undefined : status,
        );
        this.state.put("taskReportReceipts",receipt,{notificationId});
        this.state.put("jobTaskReport",job.id,content);
        return {ok:true,notificationId};
      });
    }
    const worker = this.state.get<Worker>(
      "workers",
      textField(body, "workerId"),
    );
    if (!worker || !this.ownsWorker(job, worker))
      throw new Error("Worker not owned by this user");
    if (this.workerOperations.has(worker.id))
      throw new Error("Worker operation in progress; retry shortly");
    const mutatingWorker = ["send", "resume", "stop"].includes(action);
    if (mutatingWorker) this.workerOperations.add(worker.id);
    try {
      if (job.kind === "review" && mutatingWorker) {
        const plan = this.state.get<ReviewWork>("reviewWork", worker.id);
        if (["stopped", "blocked", "working", "starting"].includes(worker.state) || worker.recoveryHold || plan?.state === "waiting" || plan?.state === "done" || (worker.result && plan?.state !== "pending") ||
            this.state.all<Delivery>("deliveries").some(d => d.workerId === worker.id && ["queued", "sending", "uncertain"].includes(d.status)) ||
            this.state.all<Outbox>("outbox").some(o => o.conversationId === job.conversationId && ["sending", "uncertain"].includes(o.status)))
          throw new Error("Periodic continuation held by approval, stopped work or uncertain effects");
        if (worker.taskId) {
          const task = await this.assertAssigned(worker.taskId);
          this.assertTaskOwner(task, this.projectConversation(job));
          if (task.status !== "RUNNING" && task.status !== "READY") throw new Error("Task needs external input or approval");
        }
      }
      if (mutatingWorker) await this.reconcileArchive(worker);
      if (action === "stop") {
        if (!worker.paneId) throw new Error("Worker has no pane");
        if (!(await this.workerAgent(worker)))
          throw new Error("Worker process is missing");
        await this.herdr.call(["agent", "send-keys", worker.paneId, "ctrl+c"]);
        const current = this.state.get<Worker>("workers", worker.id)!;
        current.state = "stopped";
        current.generation = (current.generation ?? 0) + 1;
        this.state.put("workers", current.id, current);
        return { ok: true };
      }
      if (action === "resume") {
        const uncertain = this.state.all<Delivery>("deliveries").filter(d => d.workerId === worker.id && ["sending", "uncertain"].includes(d.status));
        if (worker.recoveryHold || uncertain.length)
          return { status: "recovery_blocked", workerId: worker.id, approvalHold: Boolean(worker.recoveryHold), uncertainDeliveryIds: uncertain.map(d => d.id), reason: "Reconcile prior instructions and any human approval before resuming. No instruction queued or session launched." };
        if (
          !worker.result &&
          ["missing", "launch_failed", "recovery_blocked"].includes(
            worker.state,
          )
        ) {
          await this.workerAgent(worker); // Refuse to reset a pane owned by someone else.
          await this.prepareFollowup(worker, textField(body, "text"));
          worker.state = "missing";
          worker.recoveryAttempts = 0;
          worker.nextRecoveryAt = undefined;
          worker.error = undefined;
          this.state.put("workers", worker.id, worker);
          return this.queueInstruction(worker, textField(body, "text"));
        }
        if (worker.archivedAt) {
          await this.prepareFollowup(worker, textField(body, "text"));
          await this.wakeWorker(worker);
          return this.queueInstruction(worker, textField(body, "text"));
        }
        const live = await this.workerAgent(worker);
        if (!live && worker.result) {
          const workspace = this.state.get<string>("meta", "workspace");
          if (!workspace) throw new Error("CodePat workspace is not ready");
          const listing = await this.herdr.call(["pane", "list", "--workspace", workspace]);
          if (!Array.isArray(listing.panes)) throw new Error("Cannot verify missing worker pane");
          if (listing.panes.some(p => record(p).pane_id === worker.paneId)) {
            const info = record(record(await this.herdr.call(["pane", "process-info", "--pane", worker.paneId!])).process_info);
            const foreground = Array.isArray(info.foreground_processes) ? info.foreground_processes.map(record) : [];
            if (foreground.length !== 1 || foreground[0].pid !== info.shell_pid)
              return { status: "recovery_blocked", workerId: worker.id, reason: "Worker pane still owns a process; retained without duplicate launch." };
          }
          await this.prepareFollowup(worker, textField(body, "text"));
          await this.wakeWorker(worker);
          return this.queueInstruction(worker, textField(body, "text"));
        }
        if (!live || !["idle", "done"].includes(live.agent_status))
          throw new Error("Worker must be at its prompt before resuming");
        await this.prepareFollowup(worker, textField(body, "text"));
        worker.state = "idle";
        this.state.put("workers", worker.id, worker);
        return this.queueInstruction(worker, textField(body, "text"));
      }
      if (action === "send") {
        if (worker.state === "stopped")
          throw new Error(
            "Worker is stopped; explicitly resume it with new instructions",
          );
        await this.prepareFollowup(worker, textField(body, "text"));
        await this.wakeWorker(worker);
        return this.queueInstruction(worker, textField(body, "text"));
      }
      if (action === "read") {
        if (worker.archivedAt)
          return {
            archived: true,
            text: worker.result,
            worktree: worker.worktree,
            taskUrl: worker.taskUrl,
          };
        if (!worker.paneId) throw new Error("Worker has no pane");
        if (!(await this.workerAgent(worker))) {
          if (worker.result) return { missing: true, workerId: worker.id, text: worker.result, recoveryHold: Boolean(worker.recoveryHold), worktree: worker.worktree, taskUrl: worker.taskUrl, note: "Saved result is not proof the parent task is complete; session recovery requires reconciliation." };
          throw new Error("Worker process is missing");
        }
        return this.herdr.call([
          "agent",
          "read",
          worker.paneId,
          "--source",
          "recent-unwrapped",
          "--lines",
          "80",
        ]);
      }
      throw new Error("Unknown action");
    } finally {
      if (mutatingWorker) this.workerOperations.delete(worker.id);
    }
  }
}
