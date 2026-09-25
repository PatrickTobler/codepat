import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, HerdrPort } from "./herdr.ts";
import { Runtime } from "./runtime.ts";
import { type Job, type Outbox, State } from "./state.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codepat-test-"));
  writeFileSync(
    join(dir, "client.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", token: "master" }),
  );
  const state = new State(join(dir, "state.sqlite"));
  const calls: string[][] = [];
  let agents: Agent[] = [];
  const herdr: HerdrPort = {
    call: async (args) => {
      calls.push(args);
      return args[0] === "workspace"
        ? { workspaces: [{ workspace_id: "w1", label: "CodePat" }] }
        : {};
    },
    agents: async () => agents,
  };
  const config = {
    dataDir: dir,
    cliPath: "cli.ts",
    repo: dir,
    apiUrl: "http://127.0.0.1:1",
    apiKey: "test",
    coworkerId: "codepat",
  };
  const runtime = new Runtime(state, herdr, config);
  return {
    dir,
    state,
    runtime,
    herdr,
    config,
    calls,
    setAgents: (next: Agent[]) => {
      agents = next;
    },
    token: (jobConfig: string) =>
      String(JSON.parse(readFileSync(jobConfig, "utf8")).token),
    close: () => {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function taskJob(f: ReturnType<typeof fixture>, taskId = "task-1") {
  const conversation = f.runtime.createConversation("alice", {
    taskId,
    sokosumi_organization_id: "org",
  });
  f.state.put("taskConversations", taskId, conversation.id);
  const job = f.state.enqueue({
    conversationId: conversation.id,
    kind: "task",
    taskId,
    input: "task event",
  });
  return { conversation, job };
}
const assignedTask = {
  id: "task-1",
  assigneeId: "codepat",
  status: "RUNNING",
  ownerId: "alice",
  organizationId: "org",
};

test("chat idempotency persists across restart and isolates keys by conversation", () => {
  const f = fixture();
  try {
    const a = f.runtime.createConversation("alice", {});
    const b = f.runtime.createConversation("bob", {});
    const first = f.runtime.createResponse("alice", a.id, "do work", "key");
    assert.equal(
      f.runtime.createResponse("alice", a.id, "do work", "key").id,
      first.id,
    );
    assert.notEqual(
      f.runtime.createResponse("bob", b.id, "do work", "key").id,
      first.id,
    );
    assert.throws(() => f.runtime.createResponse("bob", a.id, "steal"));
    assert.throws(() =>
      f.runtime.createResponse("alice", a.id, "different", "key"),
    );
    const reopened = new State(join(f.dir, "state.sqlite"));
    try {
      const restarted = new Runtime(reopened, f.herdr, f.config);
      assert.equal(restarted.findResponse("alice", a.id, "key")?.id, first.id);
      assert.equal(restarted.conversationOwner(a.id), "alice");
      assert.equal(reopened.all("jobs").length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("startup retires queued legacy workflow jobs", () => {
  const f = fixture();
  try {
    const legacy = {
      id: "legacy-review",
      conversationId: "legacy-conversation",
      kind: "review",
      input: "old periodic review",
      status: "queued",
      text: "",
      createdAt: Date.now(),
    } as unknown as Job;
    f.state.put("jobs", legacy.id, legacy);
    const restarted = new Runtime(f.state, f.herdr, f.config);
    assert.equal(restarted.job(legacy.id).status, "failed");
    assert.equal(restarted.job(legacy.id).error, "legacy_workflow_retired");
    assert.equal(restarted.nextJob("runner", 1), null);
  } finally {
    f.close();
  }
});

test("one supervised turn at a time with durable claim, progress, thread and completion", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const first = f.runtime.createResponse("alice", c.id, "hello");
    const second = f.runtime.createResponse("alice", c.id, "later");
    const next = f.runtime.nextJob("runner-1", 1)!;
    assert.equal(next.job.id, first.id);
    assert.equal(f.runtime.nextJob("runner-2", 1), null);
    assert.equal(f.runtime.nextJob("runner-1", 1)!.job.id, first.id);
    await f.runtime.control("begin-turn", { jobId: first.id, runnerId: "runner-1" });
    await assert.rejects(
      f.runtime.control("begin-turn", { jobId: first.id, runnerId: "runner-1" }),
    );
    await f.runtime.control("progress", {
      jobId: first.id,
      items: [{ key: "0:step", kind: "activity", text: "Running a command…" }],
    });
    await f.runtime.control("thread", { jobId: first.id, threadId: "thread-1" });
    await f.runtime.control("reply", { jobId: first.id, attempt: 0, text: "done" });
    assert.equal(f.runtime.getResponse(first.id)?.status, "completed");
    assert.deepEqual(f.runtime.getProgress(first.id).map((p) => p.text), [
      "Running a command…",
    ]);
    const resumed = f.runtime.nextJob("runner-1", 1)!;
    assert.equal(resumed.job.id, second.id);
    assert.equal(resumed.threadId, "thread-1");
  } finally {
    f.close();
  }
});

test("scoped turn credentials authorize only the small coordinator surface", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "work");
    const next = f.runtime.nextJob("runner", 1)!;
    const token = f.token(next.jobConfig);
    for (const action of ["instances", "repositories", "projects", "project", "task-create", "task-continue", "task-status", "task-upload", "task-report", "task-runtime", "progress"])
      assert.equal(f.runtime.authorizeControl(token, action, { jobId: job.id }), true, action);
    for (const action of ["start", "workers", "send", "resume", "read", "stop", "next", "reply", "begin-turn", "status", "recover-chat"])
      assert.equal(f.runtime.authorizeControl(token, action, { jobId: job.id }), false, action);
    assert.equal(f.runtime.authorizeControl(token, "instances", { jobId: "resp_other" }), false);
    assert.equal(f.runtime.authorizeControl("unknown", "instances", { jobId: job.id }), false);
    f.runtime.completeJob(job.id, "done");
    assert.equal(f.runtime.authorizeControl(token, "instances", { jobId: job.id }), false);
  } finally {
    f.close();
  }
});

test("task runtimes attach arbitrary resources and wake the coordinator once when work settles", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.setAgents([{ pane_id: "w1:p9", agent_status: "working", agent: "claude", name: "builder" }]);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", {
      jobId: job.id,
      operation: "attach",
      kind: "herdr",
      resourceId: "w1:p9",
      role: "implementation",
    });
    const listed = await f.runtime.control("task-runtime", { jobId: job.id, operation: "list" }) as { resources: Array<{ resourceId: string; provider?: string }> };
    assert.deepEqual(listed.resources.map(resource => [resource.resourceId, resource.provider]), [["w1:p9", "claude"]]);
    f.runtime.completeJob(job.id, "Agent is still working.");

    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 1);
    f.setAgents([{ pane_id: "w1:p9", agent_status: "done", agent: "claude", name: "builder" }]);
    await f.runtime.pollTaskRuntimes();
    const jobs = f.state.all<Job>("jobs");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].taskId, "task-1");
    assert.match(jobs[1].input, /w1:p9.*done/);
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 2);
  } finally {
    f.close();
  }
});

test("task runtime wakes again after the same agent completes a later work cycle", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.setAgents([{ pane_id: "w1:p9", agent_status: "working", agent: "codex", revision: 7 }]);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "herdr", resourceId: "w1:p9", role: "implementation" });
    f.runtime.completeJob(job.id, "background work started");
    f.setAgents([{ pane_id: "w1:p9", agent_status: "idle", agent: "codex", revision: 7 }]);
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 2);

    const firstWake = f.runtime.nextJob("runner", 1)!;
    f.setAgents([{ pane_id: "w1:p9", agent_status: "working", agent: "codex", revision: 7 }]);
    await f.runtime.pollTaskRuntimes();
    f.runtime.completeJob(firstWake.job.id, "continued the same agent");
    f.setAgents([{ pane_id: "w1:p9", agent_status: "idle", agent: "codex", revision: 7 }]);
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 3);
  } finally {
    f.close();
  }
});

test("task runtimes support multiple external resources and explicit detach", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "external", resourceId: "ci:build-42", role: "verification" });
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "external", resourceId: "vendor:job-7", role: "research" });
    const detached = await f.runtime.control("task-runtime", { jobId: job.id, operation: "detach", kind: "external", resourceId: "ci:build-42" }) as { resources: Array<{ resourceId: string }> };
    assert.deepEqual(detached.resources.map(resource => resource.resourceId), ["vendor:job-7"]);
  } finally {
    f.close();
  }
});

test("a worker blocked before first work wakes supervision once", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.setAgents([{ pane_id: "w1:p9", agent_status: "blocked", agent: "claude" }]);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "herdr", resourceId: "w1:p9", role: "implementation" });
    f.runtime.completeJob(job.id, "Waiting for startup");
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 2);
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 2);
  } finally { f.close(); }
});

test("an idle startup gets a grace period and cannot attach to two tasks", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.setAgents([{ pane_id: "w1:p9", agent_status: "idle", agent: "codex" }]);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "herdr", resourceId: "w1:p9", role: "implementation" });
    f.runtime.completeJob(job.id, "Starting worker");
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 1);
    const runtime = f.state.get<{resources: Array<{attachedAt:number}>}>("taskRuntimes", "task-1")!;
    runtime.resources[0].attachedAt -= 61_000;
    f.state.put("taskRuntimes", "task-1", runtime);
    await f.runtime.pollTaskRuntimes();
    assert.equal(f.state.all<Job>("jobs").length, 2);
    const other = taskJob(f, "other");
    f.state.put("jobs", other.job.id, { ...other.job, status: "in_progress" });
    await assert.rejects(f.runtime.control("task-runtime", { jobId: other.job.id, operation: "attach", kind: "herdr", resourceId: "w1:p9", role: "implementation" }), /another task/);
  } finally { f.close(); }
});

test("stranded running tasks recover once across restarts without repeating execution", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    f.runtime.completeJob(job.id, "Implementation is underway");
    f.runtime.api = async () => ({ data: assignedTask });
    await f.runtime.reconcileTasks(Date.now() + 600_000);
    const jobs = f.state.all<Job>("jobs");
    assert.equal(jobs.length, 2);
    assert.match(jobs[1].input, /Inspect.*before/i);
    const restarted = new Runtime(f.state, f.herdr, f.config);
    restarted.api = f.runtime.api;
    await restarted.reconcileTasks(Date.now() + 600_001);
    assert.equal(f.state.all<Job>("jobs").length, 2);
  } finally { f.close(); }
});

test("lifecycle recovery is bounded and respects waiting tasks and active jobs", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    let status = "RUNNING";
    f.runtime.api = async () => ({ data: { ...assignedTask, status } });
    let now = Date.now() + 600_000;
    await f.runtime.reconcileTasks(now);
    assert.equal(f.state.all<Job>("jobs").length, 1, "queued work is not stranded");
    f.runtime.nextJob("runner", 1);
    f.runtime.completeJob(job.id, "Waiting");
    status = "INPUT_REQUIRED";
    await f.runtime.reconcileTasks(now);
    assert.equal(f.state.all<Job>("jobs").length, 1);
    status = "RUNNING";
    for (let attempt = 0; attempt < 2; attempt++) {
      await f.runtime.reconcileTasks(now);
      const next = f.runtime.nextJob("runner", 1)!;
      f.runtime.completeJob(next.job.id, "Unable to resolve");
      now += 600_000;
    }
    await f.runtime.reconcileTasks(now);
    await f.runtime.reconcileTasks(now + 600_000);
    assert.equal(f.state.all<Job>("jobs").length, 3);
    assert.equal(f.state.all<Outbox>("outbox").filter(item => String(item.body.comment).includes("operational attention")).length, 1);
  } finally { f.close(); }
});

test("pending instructions survive failed turns and completion requires a disposition", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.state.put("taskInputs", "comment-1", { id: "comment-1", taskId: "task-1", jobId: job.id, text: "Please use the existing worker", receivedAt: Date.now() });
    f.runtime.api = async () => ({ data: assignedTask });
    f.runtime.nextJob("runner", 1);
    await assert.rejects(f.runtime.control("task-report", { jobId: job.id, status: "COMPLETED", text: "done" }), /pending task inputs/);
    f.runtime.completeJob(job.id, "Turn interrupted", "recovery_required");
    const restarted = new Runtime(f.state, f.herdr, f.config);
    restarted.api = f.runtime.api;
    await restarted.reconcileTasks(Date.now() + 600_000);
    const next = restarted.nextJob("runner", 1)!;
    assert.equal((next.context as { taskInputs: unknown[] }).taskInputs.length, 1);
    await assert.rejects(restarted.control("task-input", { jobId: next.job.id, operation: "ack", inputId: "other", outcome: "handled", evidence: "done" }), /does not belong/);
    await restarted.control("task-input", { jobId: next.job.id, operation: "ack", inputId: "comment-1", outcome: "relayed", evidence: "w1:p9 acknowledged receipt marker comment-1" });
    await restarted.control("task-report", { jobId: next.job.id, status: "COMPLETED", text: "Verified result" });
    assert.equal((f.state.get<{ acknowledgement: { outcome: string } }>("taskInputs", "comment-1"))?.acknowledgement.outcome, "relayed");
  } finally { f.close(); }
});

test("completion is rejected while a worker is still attached", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.api = async () => ({ data: assignedTask });
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "attach", kind: "external", resourceId: "ci:123", role: "verification" });
    await assert.rejects(f.runtime.control("task-report", { jobId: job.id, status: "COMPLETED", text: "done" }), /detach/);
    await f.runtime.control("task-runtime", { jobId: job.id, operation: "detach", kind: "external", resourceId: "ci:123" });
    await f.runtime.control("task-report", { jobId: job.id, status: "COMPLETED", text: "Verified CI result" });
  } finally { f.close(); }
});

test("consolidation preserves workers and instructions and is idempotent", async () => {
  const f = fixture();
  try {
    const { conversation } = taskJob(f);
    const duplicate = taskJob(f, "duplicate");
    f.state.put("taskRuntimes", "duplicate", { taskId: "duplicate", conversationId: duplicate.conversation.id, resources: [{ kind: "herdr", resourceId: "w1:p9", role: "implementation", status: "working", attachedAt: Date.now() }] });
    f.state.put("taskInputs", "comment-1", { id: "comment-1", taskId: "duplicate", jobId: duplicate.job.id, text: "Deploy the existing work", receivedAt: Date.now() });
    const chat = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const job = f.runtime.createResponse("alice", chat.id, "Consolidate the duplicate");
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async path => ({ data: { ...assignedTask, id: path.endsWith("duplicate") ? "duplicate" : "task-1", projectId: "project" } });
    const body = { jobId: job.id, taskId: "task-1", duplicateId: "duplicate", text: "Same deliverable" };
    const first = await f.runtime.control("task-consolidate", body);
    assert.deepEqual(await f.runtime.control("task-consolidate", body), first);
    assert.equal(f.state.get<{taskId:string}>("taskInputs", "comment-1")?.taskId, "task-1");
    assert.equal(f.state.get<{resources:unknown[]}>("taskRuntimes", "duplicate")?.resources.length, 0);
    assert.equal(f.state.get<{resources:unknown[]}>("taskRuntimes", "task-1")?.resources.length, 1);
    assert.equal(f.state.get("taskConversations", "task-1"), conversation.id);
    assert.equal(f.state.get("taskRedirects", "duplicate"), "task-1");
    assert.equal(f.state.all<Outbox>("outbox").length, 2);
    assert.equal(f.calls.length, 0, "worker processes are untouched");
    await assert.rejects(f.runtime.control("task-continue", { jobId: job.id, taskId: "duplicate", text: "more" }), /consolidated/);
  } finally { f.close(); }
});

test("consolidation rejects unrelated ownership before changing local state", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const job = f.runtime.createResponse("alice", c.id, "Consolidate");
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async path => ({ data: { ...assignedTask, ownerId: path.endsWith("duplicate") ? "bob" : "alice" } });
    await assert.rejects(f.runtime.control("task-consolidate", { jobId: job.id, taskId: "task-1", duplicateId: "duplicate", text: "same" }), /owner|workspace/i);
    assert.equal(f.state.all("taskConsolidations").length, 0);
    assert.equal(f.state.all("outbox").length, 0);
  } finally { f.close(); }
});

test("an assigned existing task can be recovered into the local queue exactly once", async () => {
  const f = fixture();
  try {
    let eventId = "event-1";
    f.runtime.api = async () => ({ data: { ...assignedTask, events: [{ id: eventId }] } });
    const first = await f.runtime.control("task-recover", { taskId: "task-1" }) as { job: Job };
    const second = await f.runtime.control("task-recover", { taskId: "task-1" }) as { job: Job };
    assert.equal(first.job.id, second.job.id);
    assert.equal(first.job.kind, "task");
    assert.equal(f.runtime.conversationOwner(first.job.conversationId), "alice");
    assert.equal(f.runtime.authorizeControl("unknown", "task-recover", { jobId: first.job.id }), false);
    eventId = "event-2";
    const followup = await f.runtime.control("task-recover", { taskId: "task-1" }) as { job: Job };
    assert.notEqual(followup.job.id, first.job.id);
  } finally {
    f.close();
  }
});

test("chat task creation reconciles by marker and immediately queues the new task", async () => {
  const f = fixture();
  try {
    const projectId = "019e7d0f-9a3e-770c-94df-197a31e9bfa5";
    const conversation = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const chat = f.runtime.createResponse("alice", conversation.id, "create it");
    f.runtime.nextJob("runner", 1);
    const created: Record<string, unknown>[] = [];
    f.runtime.api = async (path, method, body) => {
      if (path.startsWith("/projects?")) return { data: [{ id: projectId }], meta: { pagination: { nextCursor: null } } };
      if (path === `/projects/${projectId}`) return { data: { id: projectId } };
      if (path.startsWith("/tasks?")) return { data: created, meta: { pagination: { nextCursor: null } } };
      if (path === "/tasks" && method === "POST") {
        const input = body as Record<string, unknown>;
        const task = { id: "created-1", ...input, projectId, organizationId: "org", ownerId: "alice", assigneeId: "codepat" };
        created.push(task);
        return { data: task };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    };
    await assert.rejects(
      f.runtime.control("task-create", { jobId: chat.id, projectId, name: "Small task", description: "Implement and verify the change." }),
      /genuinely distinct/,
    );
    const first = await f.runtime.control("task-create", { jobId: chat.id, projectId, name: "Small task", description: "Implement and verify the change.", distinct: true }) as { task: Record<string, unknown>; job: Job };
    const second = await f.runtime.control("task-create", { jobId: chat.id, projectId, name: "Small task", description: "Implement and verify the change.", distinct: true }) as { job: Job };
    assert.equal(first.task.id, "created-1");
    assert.equal(second.job.id, first.job.id);
    assert.equal(first.job.kind, "task");
    assert.equal(first.job.status, "queued");
    assert.match(String(created[0].description), new RegExp(`codepat-request:${chat.id}`));
  } finally {
    f.close();
  }
});

test("chat continuation reuses an owned task conversation and durably updates the original task", async () => {
  const f = fixture();
  try {
    const conversation = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const chat = f.runtime.createResponse("alice", conversation.id, "continue the existing task");
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: {
      ...assignedTask,
      status: "INPUT_REQUIRED",
      selectableStatuses: ["RUNNING", "CANCELED"],
    } });
    const first = await f.runtime.control("task-continue", {
      jobId: chat.id,
      taskId: "task-1",
      text: "Continue with the approved budget.",
    }) as { job: Job; notificationId: string };
    const repeated = await f.runtime.control("task-continue", {
      jobId: chat.id,
      taskId: "task-1",
      text: "Continue with the approved budget.",
    }) as { job: Job; notificationId: string };
    assert.equal(first.job.id, repeated.job.id);
    assert.equal(first.notificationId, repeated.notificationId);
    assert.equal(first.job.taskId, "task-1");
    assert.equal(first.job.kind, "task");
    assert.equal(f.runtime.conversationOwner(first.job.conversationId), "alice");
    assert.match(first.job.input, /Continue with the approved budget/);
    const outbox = f.state.all<Outbox>("outbox");
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].path, "/tasks/task-1/events");
    assert.equal(outbox[0].body.status, "RUNNING");
    assert.match(String(outbox[0].body.comment), /Continue with the approved budget/);
  } finally {
    f.close();
  }
});

test("chat continuation rejects another owner's task without creating work", async () => {
  const f = fixture();
  try {
    const conversation = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const chat = f.runtime.createResponse("alice", conversation.id, "continue it");
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: { ...assignedTask, ownerId: "mallory" } });
    await assert.rejects(
      f.runtime.control("task-continue", {
        jobId: chat.id,
        taskId: "task-1",
        text: "Continue",
      }),
      /ownership or organization/,
    );
    assert.equal(f.state.all("outbox").length, 0);
    assert.equal(f.state.all<Job>("jobs").length, 1);
  } finally {
    f.close();
  }
});

test("a chat turn can inspect an explicit owned task instead of guessing from runtimes", async () => {
  const f = fixture();
  try {
    const conversation = f.runtime.createConversation("alice", { sokosumi_organization_id: "org" });
    const chat = f.runtime.createResponse("alice", conversation.id, "what happened to task-1?");
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: { ...assignedTask, status: "INPUT_REQUIRED" } });
    const task = await f.runtime.control("task-status", { jobId: chat.id, taskId: "task-1" }) as Record<string, unknown>;
    assert.equal(task.status, "INPUT_REQUIRED");
  } finally {
    f.close();
  }
});

test("recovered reservation rotates the scoped credential generation", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "work");
    const first = f.runtime.nextJob("runner", 1)!;
    const stale = f.token(first.jobConfig);
    f.runtime.recoverInterruptedJob(job.id);
    assert.equal(f.runtime.job(job.id).status, "queued");
    const retried = f.runtime.nextJob("replacement", 1)!;
    assert.equal(retried.job.id, job.id);
    assert.equal(f.runtime.authorizeControl(stale, "instances", { jobId: job.id }), false);
    assert.equal(f.runtime.authorizeControl(f.token(retried.jobConfig), "instances", { jobId: job.id }), true);
  } finally {
    f.close();
  }
});

test("live Herdr inventory is available to the active turn", async () => {
  const f = fixture();
  try {
    f.setAgents([
      { pane_id: "w1:p1", agent_status: "working", name: "other-user-agent", cwd: "/tmp" },
    ]);
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "what is running?");
    f.runtime.nextJob("runner", 1);
    const inventory = (await f.runtime.control("instances", { jobId: job.id })) as {
      workspaces: Record<string, unknown>;
      agents: Agent[];
    };
    assert.deepEqual(inventory.workspaces, {
      workspaces: [{ workspace_id: "w1", label: "CodePat" }],
    });
    assert.equal(inventory.agents[0].pane_id, "w1:p1");
    assert.deepEqual(f.calls, [["workspace", "list"]]);
  } finally {
    f.close();
  }
});

test("scoped task reporting is idempotent and validates status, task and ownership", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: assignedTask });
    const first = (await f.runtime.control("task-report", {
      jobId: job.id,
      status: "RUNNING",
      text: "progress",
    })) as { notificationId: string; ok: boolean };
    assert.equal(first.ok, true);
    const repeat = (await f.runtime.control("task-report", {
      jobId: job.id,
      status: "RUNNING",
      text: "progress",
    })) as { notificationId: string };
    assert.equal(repeat.notificationId, first.notificationId);
    assert.equal(f.state.all("outbox").length, 1);
    await assert.rejects(
      f.runtime.control("task-report", { jobId: job.id, status: "INVALID", text: "x" }),
      /Invalid task status/,
    );
    f.runtime.api = async () => ({ data: { ...assignedTask, ownerId: "mallory" } });
    await assert.rejects(
      f.runtime.control("task-report", { jobId: job.id, status: "RUNNING", text: "y" }),
      /ownership or organization/,
    );
    const chat = f.runtime.createConversation("alice", {});
    const chatJob = f.state.enqueue({ conversationId: chat.id, kind: "chat", input: "hi" });
    f.state.put("jobs", chatJob.id, { ...chatJob, status: "in_progress" });
    await assert.rejects(
      f.runtime.control("task-report", { jobId: chatJob.id, text: "no task" }),
      /No task in this request/,
    );
  } finally {
    f.close();
  }
});

test("a comment-awakened terminal task can report RUNNING", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: { ...assignedTask, status: "COMPLETED" } });
    const result = await f.runtime.control("task-report", {
      jobId: job.id,
      status: "RUNNING",
      text: "Continuing from the user's follow-up.",
    }) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(f.state.all<Outbox>("outbox")[0].body.status, "RUNNING");
  } finally {
    f.close();
  }
});

test("task upload accepts Vercel control-plane signed URLs without forwarding API credentials", async (t) => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    const path = join(f.dir, "report.txt");
    writeFileSync(path, "acceptance report");
    let uploaded = false;
    const file = { id: "file-1", name: "report.txt", size: 17, fileUrl: "https://example.public.blob.vercel-storage.com/report.txt" };
    f.runtime.api = async (path, method = "GET") => {
      if (method === "POST") return { data: { uploadUrl: "https://vercel.com/api/blob/?vercel-blob-signature=test", headers: { "Content-Type": "text/plain" } } };
      return { data: path.endsWith("/files") ? (uploaded ? [file] : []) : assignedTask };
    };
    t.mock.method(globalThis, "fetch", async (url: string | URL, init: RequestInit) => {
      assert.equal(new URL(String(url)).origin, "https://vercel.com");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, { "Content-Type": "text/plain" });
      uploaded = true;
      return new Response(JSON.stringify({ url: file.fileUrl }), { status: 200 });
    });
    assert.deepEqual(await f.runtime.uploadTaskFile(job, path), file);
    assert.equal(uploaded, true);
  } finally { f.close(); }
});

test("task upload rejects lookalikes and unrelated Vercel paths before sending bytes", async (t) => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    const path = join(f.dir, "report.txt");
    writeFileSync(path, "test");
    t.mock.method(globalThis, "fetch", async () => { assert.fail("No bytes may be sent"); });
    for (const uploadUrl of ["https://vercel.com.evil.example/api/blob", "https://vercel.com/api/other", "http://vercel.com/api/blob", "https://user:password@vercel.com/api/blob"]) {
      f.runtime.api = async (path, method = "GET") => ({ data: method === "POST" ? { uploadUrl, headers: { "Content-Type": "text/plain" } } : path.endsWith("/files") ? [] : assignedTask });
      await assert.rejects(f.runtime.uploadTaskFile(job, path), /unsupported task upload destination; no file bytes were sent/);
    }
  } finally { f.close(); }
});

test("task upload returns a registered Sokosumi file URL without forwarding credentials", async (t) => {
  const f = fixture();
  const bytes = "verification evidence\n";
  const path = join(f.dir, "verification.md");
  writeFileSync(path, bytes);
  let uploadAuthorization: string | undefined;
  let uploaded = "";
  let registered = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/tasks/task-1") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: assignedTask }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/tasks/task-1/files") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: registered ? [{
        id: "file-1",
        taskId: "task-1",
        name: "verification.md",
        fileUrl: "https://public.blob.vercel-storage.com/tasks/task-1/verification.md",
        mimeType: "text/markdown",
        size: Buffer.byteLength(bytes),
        status: "UPLOADED",
      }] : [] }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/tasks/task-1/files") {
      assert.equal(request.headers.authorization, "Bearer test");
      assert.equal(request.headers["x-context-user-id"], "alice");
      assert.equal(request.headers["x-context-organization-id"], "org");
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      response.end(JSON.stringify({ data: {
        uploadUrl: `http://127.0.0.1:${address.port}/blob-upload`,
        pathname: "tasks/task-1/verification.md",
        access: "public",
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxSizeBytes: 104_857_600,
        addRandomSuffix: true,
      } }));
      return;
    }
    if (request.method === "PUT" && url.pathname === "/blob-upload") {
      uploadAuthorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", chunk => { uploaded += chunk; });
      request.on("end", () => {
        registered = true;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ url: "https://public.blob.vercel-storage.com/tasks/task-1/verification.md" }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  f.config.apiUrl = `http://127.0.0.1:${address.port}`;
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    const result = await f.runtime.control("task-upload", { jobId: job.id, path }) as Record<string, unknown>;
    assert.equal(result.fileUrl, "https://public.blob.vercel-storage.com/tasks/task-1/verification.md");
    assert.equal(result.name, "verification.md");
    assert.equal(uploadAuthorization, undefined);
    assert.equal(uploaded, bytes);
  } finally {
    f.close();
  }
});

test("task turn completion delivers once to the task without duplicating explicit reports", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    f.runtime.api = async () => ({ data: assignedTask });
    await f.runtime.control("task-report", {
      jobId: job.id,
      status: "COMPLETED",
      text: "final result",
    });
    await f.runtime.control("reply", { jobId: job.id, attempt: 0, text: "final result" });
    assert.equal(f.state.all("outbox").length, 1, "reply matching the report adds nothing");
    const again = taskJob(f, "task-2");
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("reply", { jobId: again.job.id, attempt: 0, text: "summary" });
    const items = f.state.all<Outbox>("outbox");
    assert.equal(items.length, 2, "an unreported final answer is delivered to the task");
    assert.match(String(items[1].body.comment), /summary/);
    assert.equal(items[1].path, "/tasks/task-2/events");
  } finally {
    f.close();
  }
});

test("failed task turn surfaces a failure notice on the task", async () => {
  const f = fixture();
  try {
    const { job } = taskJob(f);
    f.runtime.nextJob("runner", 1);
    await f.runtime.control("reply", { jobId: job.id, attempt: 0, text: "", error: "turn_timeout" });
    assert.equal(f.runtime.job(job.id).status, "failed");
    const items = f.state.all<Outbox>("outbox");
    assert.equal(items.length, 1);
    assert.match(String(items[0].body.comment), /time limit/);
  } finally {
    f.close();
  }
});

test("restart marks in-flight deliveries uncertain and never replays them blindly", async () => {
  const f = fixture();
  try {
    const { conversation } = taskJob(f);
    const id = f.runtime.reportTask("task-1", "result", "COMPLETED", conversation.id);
    const item = f.state.get<Outbox>("outbox", id)!;
    f.state.put("outbox", id, { ...item, status: "sending" });
    const restarted = new Runtime(f.state, f.herdr, f.config);
    assert.equal(f.state.get<Outbox>("outbox", id)?.status, "uncertain");
    let posts = 0;
    restarted.api = async (_path, method) => {
      if (method === "POST") posts++;
      return { data: [] };
    };
    await restarted.flushOutbox();
    assert.equal(posts, 0);
    assert.equal(f.state.get<Outbox>("outbox", id)?.status, "uncertain");
  } finally {
    f.close();
  }
});

test("chat queue prefers user chats over background task turns", () => {
  const f = fixture();
  try {
    const { job: background } = taskJob(f);
    const c = f.runtime.createConversation("alice", {});
    const chat = f.runtime.createResponse("alice", c.id, "hello");
    assert.equal(f.runtime.nextJob("runner", 1)!.job.id, chat.id);
    f.runtime.completeJob(chat.id, "hi");
    assert.equal(f.runtime.nextJob("runner", 1)!.job.id, background.id);
    assert.equal(
      (f.state.get<Job>("jobs", background.id))!.status,
      "in_progress",
    );
  } finally {
    f.close();
  }
});
