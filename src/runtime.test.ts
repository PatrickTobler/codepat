import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const action of ["instances", "repositories", "projects", "project", "task-status", "task-report", "task-runtime", "progress"])
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
