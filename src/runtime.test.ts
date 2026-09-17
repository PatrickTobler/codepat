import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Agent, git, type HerdrPort } from "./herdr.ts";
import { Runtime } from "./runtime.ts";
import { State, type Worker } from "./state.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codepat-test-"));
  writeFileSync(
    join(dir, "client.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", token: "master" }),
  );
  const state = new State(join(dir, "state.sqlite"));
  let agents: Agent[] | undefined;
  const prompts: string[] = [];
  const herdr: HerdrPort = {
    call: async () => ({}),
    agents: async () =>
      agents ??
      state
        .all<Worker>("workers")
        .filter((w) => w.paneId)
        .map((w) => ({
          pane_id: w.paneId!,
          name: w.name,
          cwd: w.worktree,
          agent_status: w.state === "completed" ? "idle" : w.state,
        })),
    prompt: async (target) => {
      prompts.push(target);
    },
  };
  const runtime = new Runtime(state, herdr, {
    dataDir: dir,
    cliPath: "cli.ts",
    repo: dir,
    apiUrl: "http://127.0.0.1:1",
  });
  return {
    dir,
    state,
    runtime,
    herdr,
    prompts,
    setAgents: (next: Agent[]) => {
      agents = next;
    },
    close: () => {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function worker(id: string, conversationId: string): Worker {
  return {
    id,
    name: `cp-${id}`,
    prompt: "test",
    repo: "/tmp",
    worktree: `/tmp/${id}`,
    branch: id,
    paneId: `w1:${id}`,
    conversationId,
    state: "working",
    observedAt: 0,
    createdAt: 0,
  };
}

test("response retry persists once and isolates keys by conversation", () => {
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
    assert.equal(reopened.all("jobs").length, 2);
    reopened.close();
  } finally {
    f.close();
  }
});

test("monitor keeps observing two workers during an active orchestrator turn", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "status");
    f.runtime.nextJob();
    for (const id of ["a", "b"]) f.state.put("workers", id, worker(id, c.id));
    f.setAgents([
      { pane_id: "w1:a", agent_status: "working", name: "cp-a", cwd: "/tmp/a" },
      { pane_id: "w1:b", agent_status: "blocked", name: "cp-b", cwd: "/tmp/b" },
    ]);
    await f.runtime.monitor();
    assert.equal(f.runtime.getResponse(job.id)?.status, "in_progress");
    assert.equal(f.runtime.workers()[0].state, "working");
    assert.equal(f.runtime.workers()[1].state, "blocked");
    assert.ok(f.runtime.monitorAt > 0);
    const count = f.state.all("jobs").length;
    await f.runtime.monitor();
    assert.equal(
      f.state.all("jobs").length,
      count,
      "unchanged status must not enqueue duplicate notices",
    );
  } finally {
    f.close();
  }
});

test("steering targets owned busy worker; blocked worker stays queued", async () => {
  const f = fixture();
  try {
    const a = f.runtime.createConversation("alice", {});
    const b = f.runtime.createConversation("bob", {});
    const job = f.runtime.createResponse("alice", a.id, "change scope");
    f.runtime.nextJob();
    f.state.put("workers", "a", worker("a", a.id));
    f.state.put("workers", "b", worker("b", b.id));
    await assert.rejects(
      f.runtime.control("send", {
        jobId: job.id,
        workerId: "b",
        text: "wrong owner",
      }),
    );
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: "a",
      text: "new scope",
    });
    await f.runtime.deliver();
    assert.deepEqual(f.prompts, ["w1:a"]);
    const blocked = { ...worker("a", a.id), state: "blocked" };
    f.state.put("workers", "a", blocked);
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: "a",
      text: "queued scope",
    });
    await f.runtime.deliver();
    assert.deepEqual(f.prompts, ["w1:a"]);
  } finally {
    f.close();
  }
});

test("uncertain delivery is never blindly replayed on restart", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = worker("a", c.id);
    f.state.put("workers", w.id, w);
    const d = f.runtime.queueInstruction(w, "work");
    f.state.put("deliveries", d.id, { ...d, status: "sending" });
    const restarted = new Runtime(f.state, f.herdr, f.runtime.config);
    await restarted.deliver();
    assert.equal(f.prompts.length, 0);
    assert.equal(
      f.state.get<{ status: string }>("deliveries", d.id)?.status,
      "uncertain",
    );
  } finally {
    f.close();
  }
});

test("chat priority and single orchestrator turn do not limit active workers", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    f.state.enqueue({
      conversationId: c.id,
      kind: "worker",
      input: "worker status",
    });
    const chat = f.runtime.createResponse("alice", c.id, "hello");
    assert.equal(f.runtime.nextJob()?.job.id, chat.id);
    assert.equal(f.runtime.nextJob(), null);
    f.runtime.completeJob(chat.id, "hello");
    assert.equal(f.runtime.nextJob()?.job.kind, "worker");
  } finally {
    f.close();
  }
});

test("a result received during prompt submission is not overwritten", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = worker("a", c.id);
    f.state.put("workers", w.id, w);
    f.runtime.queueInstruction(w, "finish");
    f.herdr.prompt = async () => {
      await f.runtime.control("worker-result", {
        workerId: w.id,
        text: "verified result",
      });
    };
    await f.runtime.deliver();
    assert.equal(
      f.state.get<Worker>("workers", w.id)?.result,
      "verified result",
    );
    assert.equal(f.state.get<Worker>("workers", w.id)?.state, "completed");
  } finally {
    f.close();
  }
});

test("result completion and notification are one transaction", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {
      sokosumi_room_id: "room-a",
    });
    const job = f.state.enqueue({
      conversationId: c.id,
      kind: "worker",
      input: "result",
    });
    f.runtime.nextJob();
    f.runtime.outbox = () => {
      throw new Error("disk full");
    };
    assert.throws(() => f.runtime.completeJob(job.id, "done"), /disk full/);
    assert.equal(f.runtime.getResponse(job.id)?.status, "in_progress");
  } finally {
    f.close();
  }
});

test("lost claim response can be recovered by the same runner only", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "hello");
    const claimed = f.runtime.nextJob("runner-a");
    assert.equal(claimed?.job.id, job.id);
    assert.equal(f.runtime.nextJob("runner-b"), null);
    assert.equal(f.runtime.nextJob("runner-a")?.jobConfig, claimed?.jobConfig);
    f.runtime.completeJob(job.id, "done");
    f.runtime.completeJob(job.id, "duplicate reply");
    assert.equal(f.runtime.getResponse(job.id)?.text, "done");
  } finally {
    f.close();
  }
});

test("credential write failure does not strand a job in progress", () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "hello");
    f.runtime.scopedConfig = () => {
      throw new Error("disk full");
    };
    assert.throws(() => f.runtime.nextJob("runner-a"), /disk full/);
    assert.equal(f.runtime.getResponse(job.id)?.status, "queued");
  } finally {
    f.close();
  }
});

test("instance inventory includes agents outside the requesting user's workers", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "what is running");
    f.runtime.nextJob();
    f.setAgents([
      { pane_id: "external:p1", agent_status: "working", name: "external" },
    ]);
    const result = await f.runtime.control("instances", { jobId: job.id });
    assert.deepEqual(result, {
      observedAt: (result as { observedAt: number }).observedAt,
      workspaces: {},
      agents: [
        { pane_id: "external:p1", agent_status: "working", name: "external" },
      ],
    });
    assert.deepEqual(f.runtime.workers(f.runtime.job(job.id)), []);
  } finally {
    f.close();
  }
});

test("chat worker task belongs to requesting user and org; existing task is reused", async () => {
  const f = fixture();
  try {
    f.runtime.config.coworkerId = "codepat";
    const c = f.runtime.createConversation("alice", {
      sokosumi_organization_id: "example-org",
    });
    const job = f.runtime.createResponse("alice", c.id, "code");
    const w = worker("new", c.id);
    w.projectId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    let calls = 0;
    f.runtime.api = async (path, method, body, headers) => {
      calls++;
      assert.equal(path, "/tasks");
      assert.equal(method, "POST");
      assert.deepEqual(headers, {
        "X-Context-User-Id": "alice",
        "X-Context-Organization-Id": "example-org",
      });
      assert.equal((body as { assigneeId: string }).assigneeId, "codepat");
      assert.equal((body as { projectId: string }).projectId, w.projectId);
      return { data: { id: "task-1", status: "READY", projectId: w.projectId } };
    };
    await f.runtime.createWorkerTask(w, job, "test-task");
    await f.runtime.createWorkerTask(w, job, "test-task");
    assert.equal(calls, 1);
    assert.equal(w.taskUrl, "https://app.sokosumi.com/tasks/task-1");
    assert.equal(f.state.get("taskConversations", "task-1"), c.id);
  } finally {
    f.close();
  }
});

test("ambiguous task creation reserves worker and never repeats POST on retry", async () => {
  const f = fixture();
  try {
    f.runtime.config.coworkerId = "codepat";
    const c = f.runtime.createConversation("alice", {
      sokosumi_organization_id: "example-org",
    });
    const job = f.runtime.createResponse("alice", c.id, "code");
    let calls = 0;
    f.runtime.inspectProject = async () => ({});
    f.runtime.api = async () => {
      calls++;
      throw new Error("connection lost after POST");
    };
    const first = await f.runtime.startWorker(job, "Implement task", "stable", { projectId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
    const retry = await f.runtime.startWorker(job, "Implement task", "stable", { projectId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
    assert.equal(first.state, "launch_failed");
    assert.equal(first.id, retry.id);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});

test("task completion cannot stop unfinished sibling workers", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.state.enqueue({
      conversationId: c.id,
      kind: "worker",
      input: "review",
      taskId: "task-1",
    });
    f.runtime.nextJob();
    f.state.put("workers", "a", {
      ...worker("a", c.id),
      taskId: "task-1",
      result: "done",
      state: "completed",
    });
    f.state.put("workers", "b", { ...worker("b", c.id), taskId: "task-1" });
    f.runtime.assertAssigned = async () => ({});
    await assert.rejects(
      f.runtime.control("task-report", {
        jobId: job.id,
        status: "COMPLETED",
        text: "done",
      }),
      /unfinished workers/,
    );
    assert.equal(f.state.all("outbox").length, 0);
    await f.runtime.control("task-report", {
      jobId: job.id,
      status: "RUNNING",
      text: "one done",
    });
    assert.equal(f.state.all("outbox").length, 1);
  } finally {
    f.close();
  }
});

test("follow-up reopens completed assigned task and preserves worker identity", async () => {
  const f = fixture();
  try {
    f.runtime.config.coworkerId = "codepat";
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "follow up");
    f.runtime.nextJob();
    f.state.put("workers", "a", {
      ...worker("a", c.id),
      taskId: "task-1",
      state: "completed",
      result: "old result",
    });
    const calls: string[] = [];
    f.runtime.api = async (path, method, body) => {
      calls.push(`${method ?? "GET"} ${path}`);
      if (method === "POST") {
        assert.equal((body as { status: string }).status, "RUNNING");
        return { data: {} };
      }
      return { data: { assigneeId: "codepat", status: "COMPLETED" } };
    };
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: "a",
      text: "add another test",
    });
    assert.deepEqual(calls, ["GET /tasks/task-1", "POST /tasks/task-1/events"]);
    assert.equal(f.state.all("workers").length, 1);
    assert.equal(f.state.all("deliveries").length, 1);
  } finally {
    f.close();
  }
});

test("follow-up supersedes queued completion before dispatch", async () => {
  const f = fixture();
  try {
    f.runtime.config.coworkerId = "codepat";
    f.runtime.config.apiKey = "test";
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "continue");
    f.runtime.nextJob();
    f.state.put("workers", "a", {
      ...worker("a", c.id),
      taskId: "task-1",
      state: "completed",
      result: "done",
    });
    f.runtime.reportTask("task-1", "done", "COMPLETED");
    const posted: string[] = [];
    f.runtime.api = async (path, method) => {
      if (method === "POST") posted.push(path);
      return { data: { assigneeId: "codepat", status: "RUNNING" } };
    };
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: "a",
      text: "more work",
    });
    await f.runtime.flushOutbox();
    assert.deepEqual(posted, []);
    assert.equal(
      f.state.all<{ status: string }>("outbox")[0].status,
      "superseded",
    );
  } finally {
    f.close();
  }
});

test("outbox reloads superseded completion after an earlier HTTP await", async () => {
  const f = fixture();
  try {
    f.runtime.config.apiKey = "test";
    f.runtime.reportTask("other-task", "progress");
    f.runtime.reportTask("task-1", "done", "COMPLETED");
    const posted: string[] = [];
    f.runtime.api = async (path) => {
      posted.push(path);
      const completion = f.state
        .all<{ id: string; status: string; body: { status?: string } }>(
          "outbox",
        )
        .find((item) => item.body.status === "COMPLETED")!;
      completion.status = "superseded";
      f.state.put("outbox", completion.id, completion);
      return {};
    };
    await f.runtime.flushOutbox();
    assert.deepEqual(posted, ["/tasks/other-task/events"]);
  } finally {
    f.close();
  }
});

test("cleanup closes only owned completed idle worker and keeps its code records", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = {
      ...worker("a", c.id),
      state: "completed",
      result: "verified",
      idleSince: 1,
    };
    f.state.put("workers", w.id, w);
    f.setAgents([
      {
        pane_id: w.paneId!,
        agent_status: "idle",
        name: w.name,
        cwd: w.worktree,
      },
    ]);
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return {};
    };
    await f.runtime.cleanupWorkers(1000);
    assert.equal(calls.length, 0);
    await f.runtime.cleanupWorkers(900_001);
    assert.deepEqual(calls, [["pane", "close", w.paneId]]);
    const saved = f.state.get<Worker>("workers", w.id)!;
    assert.equal(saved.archivedAt, 900_001);
    assert.equal(saved.paneId, undefined);
    assert.equal(saved.worktree, w.worktree);
    assert.equal(saved.result, "verified");
    assert.equal(saved.state, "completed");
  } finally {
    f.close();
  }
});

test("cleanup protects busy, blocked, replaced agents and pending work", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = {
      ...worker("a", c.id),
      state: "completed",
      result: "verified",
      idleSince: 1,
    };
    f.state.put("workers", w.id, w);
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return {};
    };
    for (const [agent_status, name] of [
      ["working", w.name],
      ["blocked", w.name],
      ["idle", "someone-else"],
    ]) {
      f.setAgents([
        { pane_id: w.paneId!, agent_status, name, cwd: w.worktree },
      ]);
      await f.runtime.cleanupWorkers(900_001);
    }
    f.setAgents([
      {
        pane_id: w.paneId!,
        agent_status: "idle",
        name: w.name,
        cwd: w.worktree,
      },
    ]);
    f.runtime.createResponse("alice", c.id, "follow up");
    await f.runtime.cleanupWorkers(900_001);
    assert.deepEqual(calls, []);
  } finally {
    f.close();
  }
});

test("follow-up restores archived session in same worktree without creating task or worker", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "continue");
    f.runtime.nextJob();
    const w = {
      ...worker("a", c.id),
      state: "completed",
      result: "verified",
      archivedAt: 1,
      paneId: undefined,
    };
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w5");
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return { root_pane: { pane_id: "w5:p99" } };
    };
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: w.id,
      text: "continue",
    });
    assert.equal(calls[0][0], "tab");
    assert.ok(calls[0].includes(w.worktree));
    assert.ok(calls[1].includes("resume"));
    assert.ok(calls[1].includes("--last"));
    const saved = f.state.get<Worker>("workers", w.id)!;
    assert.equal(saved.archivedAt, undefined);
    assert.equal(saved.paneId, "w5:p99");
    assert.equal(f.state.all("workers").length, 1);
    assert.equal(f.state.all("deliveries").length, 1);
  } finally {
    f.close();
  }
});

test("parallel follow-ups cannot launch two archived sessions", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "continue");
    f.runtime.nextJob();
    f.state.put("workers", "a", {
      ...worker("a", c.id),
      paneId: undefined,
      archivedAt: 1,
      state: "completed",
      result: "done",
    });
    f.state.put("meta", "workspace", "w5");
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      started = r;
    });
    let tabs = 0;
    f.herdr.call = async (args) => {
      if (args[0] === "tab") {
        tabs++;
        started();
        await pending;
      }
      return { root_pane: { pane_id: "w5:p99" } };
    };
    const first = f.runtime.control("send", {
      jobId: job.id,
      workerId: "a",
      text: "continue",
    });
    await entered;
    await assert.rejects(
      f.runtime.control("send", {
        jobId: job.id,
        workerId: "a",
        text: "continue again",
      }),
      /operation in progress/,
    );
    release();
    await first;
    assert.equal(tabs, 1);
  } finally {
    f.close();
  }
});

test("interrupted close reconciles missing pane while retaining result and worktree", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = {
      ...worker("a", c.id),
      state: "completed",
      result: "verified",
      idleSince: 1,
    };
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w5");
    f.setAgents([
      {
        pane_id: w.paneId!,
        agent_status: "idle",
        name: w.name,
        cwd: w.worktree,
      },
    ]);
    f.herdr.call = async () => {
      throw new Error("response lost after pane closed");
    };
    await assert.rejects(f.runtime.cleanupWorkers(900_001));
    assert.equal(
      f.state.get<Worker>("workers", w.id)?.archiveRequestedAt,
      900_001,
    );
    f.herdr.call = async () => ({ panes: [] });
    await f.runtime.cleanupWorkers(900_002);
    const saved = f.state.get<Worker>("workers", w.id)!;
    assert.equal(saved.paneId, undefined);
    assert.equal(saved.archivedAt, 900_001);
    assert.equal(saved.worktree, w.worktree);
    assert.equal(saved.result, "verified");
  } finally {
    f.close();
  }
});

test("completed worker whose process disappeared resumes on follow-up", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "continue");
    f.runtime.nextJob();
    const w = { ...worker("a", c.id), state: "completed", result: "done" };
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w5");
    f.setAgents([]);
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return { root_pane: { pane_id: "w5:new" } };
    };
    await f.runtime.control("send", {
      jobId: job.id,
      workerId: w.id,
      text: "continue",
    });
    assert.ok(calls.some((args) => args.includes("resume")));
    assert.ok(!calls.some((args) => args.includes("close")));
    assert.equal(f.state.get<Worker>("workers", w.id)?.paneId, "w5:new");
    assert.equal(f.state.all("workers").length, 1);
    assert.equal(f.state.all("deliveries").length, 1);
  } finally {
    f.close();
  }
});

test("replacement agents are never read, interrupted, or sent worker instructions", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "status");
    f.runtime.nextJob();
    const w = worker("a", c.id);
    f.state.put("workers", w.id, w);
    f.setAgents([
      {
        pane_id: w.paneId!,
        name: "unrelated",
        cwd: "/elsewhere",
        agent_status: "idle",
      },
    ]);
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return {};
    };
    for (const action of ["read", "stop", "resume"])
      await assert.rejects(
        f.runtime.control(action, {
          jobId: job.id,
          workerId: w.id,
          text: "continue",
        }),
        /another agent/,
      );
    f.runtime.queueInstruction(w, "work");
    await f.runtime.deliver();
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(calls, []);
    await f.runtime.monitor();
    assert.equal(
      f.state.get<Worker>("workers", w.id)?.state,
      "recovery_blocked",
    );
  } finally {
    f.close();
  }
});

test("restart reconciles interrupted starts without creating duplicate workers", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w = {
      ...worker("a", c.id),
      worktree: f.dir,
      state: "starting",
      taskId: "task-1",
    };
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w1");
    f.setAgents([
      {
        pane_id: w.paneId!,
        name: w.name,
        cwd: w.worktree,
        agent_status: "idle",
      },
    ]);
    const calls: string[][] = [];
    f.herdr.call = async (args) => {
      calls.push(args);
      return { panes: [{ pane_id: w.paneId, cwd: w.worktree }] };
    };
    const restarted = new Runtime(f.state, f.herdr, f.runtime.config);
    assert.equal(f.state.get<Worker>("workers", w.id)?.state, "launch_failed");
    restarted.assertAssigned = async () => ({});
    await restarted.recoverWorkers();
    assert.ok(
      !calls.some((args) => args.includes("start") || args.includes("create")),
    );
    assert.equal(f.state.all("workers").length, 1);
    assert.equal(f.state.all("deliveries").length, 1);
    assert.equal(f.state.get<Worker>("workers", w.id)?.state, "idle");
  } finally {
    f.close();
  }
});

test("worker starts from a user-requested local checkout without configuring an alias", async () => {
  const f = fixture();
  try {
    const repo = join(f.dir, "requested landing repo");
    mkdirSync(repo);
    await git(["init", repo]);
    await git([
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    f.runtime.config.coworkerId = "codepat";
    f.runtime.api = async () => ({
      data: { assigneeId: "codepat", status: "READY", ownerId: "alice", organizationId: "example-org" },
    });
    f.state.put("meta", "workspace", "w1");
    f.herdr.call = async (args) =>
      args[0] === "tab" ? { root_pane: { pane_id: "w1:new" } } : {};
    const conversation = f.runtime.createConversation("alice", { sokosumi_organization_id: "example-org" });
    const job = f.runtime.createResponse(
      "alice",
      conversation.id,
      "Fix the landing page",
    );
    job.taskId = "existing-task";
    const worker = await f.runtime.startWorker(
      job,
      "Improve the homepage",
      "landing",
      { repository: repo, baseBranch: "HEAD" },
    );
    assert.equal(worker.repo, repo);
    assert.equal(worker.state, "idle");
    assert.equal(worker.taskId, "existing-task");
    assert.equal(
      await git(["-C", worker.worktree, "rev-parse", "--show-toplevel"]),
      worker.worktree,
    );
    assert.equal(
      (
        await f.runtime.startWorker(job, "Improve the homepage", "landing", {
          repository: repo,
        })
      ).id,
      worker.id,
    );
    assert.equal(f.state.all("workers").length, 1);
  } finally {
    f.close();
  }
});

test("resume retries a repaired failed launch on the same worker and task", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse(
      "alice",
      c.id,
      "Continue the repaired task",
    );
    f.runtime.nextJob();
    const w = worker("repair", c.id);
    Object.assign(w, {
      paneId: undefined,
      taskId: "same-task",
      repo: f.dir,
      worktree: f.dir,
      state: "recovery_blocked",
      recoveryAttempts: 2,
    });
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w1");
    f.runtime.config.coworkerId = "codepat";
    f.runtime.api = async () => ({
      data: { assigneeId: "codepat", status: "RUNNING" },
    });
    f.setAgents([]);
    f.herdr.call = async (args) =>
      args[0] === "tab"
        ? { root_pane: { pane_id: "w1:recovered" } }
        : { panes: [] };
    await f.runtime.control("resume", {
      jobId: job.id,
      workerId: w.id,
      text: "The worktree is repaired; finish the PR",
    });
    await f.runtime.recoverWorkers();
    const saved = f.state.get<Worker>("workers", w.id)!;
    assert.equal(saved.state, "idle");
    assert.equal(saved.paneId, "w1:recovered");
    assert.equal(saved.taskId, "same-task");
    assert.equal(f.state.all("workers").length, 1);
  } finally {
    f.close();
  }
});
