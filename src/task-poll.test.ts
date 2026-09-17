import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HerdrPort } from "./herdr.ts";
import { Runtime } from "./runtime.ts";
import { type Job, State, type Worker } from "./state.ts";

interface TaskEvent {
  id: string;
  taskId: string;
  coworkerId: string | null;
}
interface Task {
  id: string;
  userId: string;
  assigneeId: string;
  status: string;
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-task-poll-"));
  const statePath = join(dir, "state.sqlite");
  const state = new State(statePath);
  const tasks = new Map<string, Task>();
  const events: TaskEvent[] = [];
  const requestedCursors: (string | null)[] = [];
  const requestedTasks: string[] = [];
  const herdrCalls: string[][] = [];
  let replay = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-test-token");
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/coworkers/me/events") {
      const cursor = url.searchParams.get("cursor");
      requestedCursors.push(cursor);
      const start =
        cursor && !replay
          ? events.findIndex((event) => event.id === cursor) + 1
          : 0;
      // Even the final nonempty page reports null; the last event remains the resume cursor.
      res.end(
        JSON.stringify({
          data: events.slice(start),
          pagination: { nextCursor: null },
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/tasks/")) {
      const id = decodeURIComponent(url.pathname.slice("/tasks/".length));
      requestedTasks.push(id);
      const task = tasks.get(id);
      res.statusCode = task ? 200 : 404;
      res.end(JSON.stringify(task ? { data: task } : { error: "Not found" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const herdr: HerdrPort = {
    call: async (args) => {
      herdrCalls.push(args);
      return {};
    },
    agents: async () =>
      state
        .all<Worker>("workers")
        .filter((w) => w.paneId)
        .map((w) => ({
          pane_id: w.paneId!,
          name: w.name,
          cwd: w.worktree,
          agent_status: "working",
        })),
    prompt: async () => {
      assert.fail("Task polling must enqueue work, not directly prompt agents");
    },
  };
  const config = {
    dataDir: dir,
    cliPath: "cli.ts",
    repo: dir,
    apiUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "local-test-token",
    coworkerId: "codepat",
  };
  const runtime = new Runtime(state, herdr, config);
  function addTask(id: string, status = "READY", assigneeId = "codepat") {
    tasks.set(id, { id, status, assigneeId, userId: "alice" });
  }
  function trackWorker(taskId: string) {
    const conversation = runtime.createConversation("alice", { taskId });
    const worker: Worker = {
      id: `worker-${taskId}`,
      name: `worker-${taskId}`,
      prompt: "work",
      repo: dir,
      worktree: dir,
      branch: `test-${taskId}`,
      taskId,
      conversationId: conversation.id,
      paneId: `w1:${taskId}`,
      state: "working",
      observedAt: 0,
      createdAt: 0,
    };
    state.put("workers", worker.id, worker);
    return worker;
  }
  return {
    state,
    statePath,
    runtime,
    herdr,
    config,
    events,
    addTask,
    trackWorker,
    requestedCursors,
    requestedTasks,
    herdrCalls,
    replay: () => {
      replay = true;
    },
  };
}

test("new READY assignment enqueues once and final-page cursor survives restart", async (t) => {
  const f = await fixture(t);
  f.addTask("first");
  f.events.push({ id: "event-1", taskId: "first", coworkerId: null });
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  const jobs = f.state.all<Job>("jobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "task");
  assert.equal(jobs[0].taskId, "first");
  assert.equal(f.runtime.conversationOwner(jobs[0].conversationId), "alice");
  assert.equal(f.state.get("meta", "taskCursor"), "event-1");
  // An overlapping event page must not create a second job.
  f.replay();
  await f.runtime.pollTasks();
  assert.equal(f.state.all("jobs").length, 1);
  const reopened = new State(f.statePath);
  try {
    const restarted = new Runtime(reopened, f.herdr, f.config);
    f.addTask("second");
    f.events.push({ id: "event-2", taskId: "second", coworkerId: null });
    await restarted.pollTasks();
    assert.equal(restarted.pollError, undefined);
    assert.deepEqual(f.requestedCursors, [null, "event-1", "event-1"]);
    assert.equal(reopened.get("meta", "taskCursor"), "event-2");
    assert.equal(reopened.all("jobs").length, 2);
    assert.deepEqual(f.requestedTasks, ["first", "second"]);
  } finally {
    reopened.close();
  }
});

test("self-authored progress advances the cursor without an orchestration loop", async (t) => {
  const f = await fixture(t);
  f.addTask("task", "RUNNING");
  f.events.push({ id: "self-1", taskId: "task", coworkerId: "codepat" });
  await f.runtime.pollTasks();
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.all("jobs").length, 0);
  assert.equal(f.state.get("meta", "taskCursor"), "self-1");
  assert.deepEqual(f.requestedCursors, [null, "self-1"]);
  assert.deepEqual(f.herdrCalls, []);
});

test("a removed task stops its worker without poisoning later events", async (t) => {
  const f = await fixture(t);
  const worker = f.trackWorker("removed");
  f.addTask("accessible");
  f.events.push(
    { id: "gone-1", taskId: "removed", coworkerId: null },
    { id: "new-2", taskId: "accessible", coworkerId: null },
  );
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.get<Worker>("workers", worker.id)?.state, "stopped");
  assert.deepEqual(f.herdrCalls, [
    ["agent", "send-keys", worker.paneId, "ctrl+c"],
  ]);
  assert.deepEqual(
    f.state
      .all<Job>("jobs")
      .filter((job) => job.kind === "task")
      .map((job) => job.taskId),
    ["accessible"],
  );
  assert.equal(f.state.get("meta", "taskCursor"), "new-2");
  assert.equal(f.state.get("taskEvents", "gone-1"), true);
});

for (const change of ["canceled", "reassigned"] as const) {
  test(`${change} task interrupts tracked worker once across later events`, async (t) => {
    const f = await fixture(t);
    f.addTask(
      "task",
      change === "canceled" ? "CANCELED" : "RUNNING",
      change === "reassigned" ? "other-agent" : "codepat",
    );
    const worker = f.trackWorker("task");
    f.events.push(
      { id: "change-1", taskId: "task", coworkerId: null },
      { id: "change-2", taskId: "task", coworkerId: null },
    );
    await f.runtime.pollTasks();
    f.replay();
    await f.runtime.pollTasks();
    assert.equal(f.runtime.pollError, undefined);
    assert.deepEqual(f.herdrCalls, [
      ["agent", "send-keys", worker.paneId, "ctrl+c"],
    ]);
    assert.equal(f.state.get<Worker>("workers", worker.id)?.state, "stopped");
    assert.equal(
      f.state.all<Job>("jobs").filter((job) => job.kind === "worker").length,
      1,
    );
    assert.equal(
      f.state.all<Job>("jobs").filter((job) => job.kind === "task").length,
      0,
    );
    assert.equal(f.state.get("meta", "taskCursor"), "change-2");
  });
}

test("reassignment stops an active worker even when its events disappear from the feed", async (t) => {
  const f = await fixture(t);
  f.addTask("task", "RUNNING");
  const worker = f.trackWorker("task");
  await f.runtime.pollTasks();
  assert.deepEqual(f.herdrCalls, []);

  // Core excludes tasks reassigned to another coworker from /me/events.
  f.addTask("task", "RUNNING", "other-agent");
  await f.runtime.pollTasks();
  await f.runtime.pollTasks();

  assert.equal(f.runtime.pollError, undefined);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.requestedTasks, ["task", "task"]);
  assert.deepEqual(f.herdrCalls, [
    ["agent", "send-keys", worker.paneId, "ctrl+c"],
  ]);
  assert.equal(f.state.get<Worker>("workers", worker.id)?.state, "stopped");
  assert.equal(
    f.state.all<Job>("jobs").filter((job) => job.kind === "worker").length,
    1,
  );
  assert.equal(
    f.state.all<Job>("jobs").filter((job) => job.kind === "task").length,
    0,
  );
});
