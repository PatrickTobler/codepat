import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HerdrPort } from "./herdr.ts";
import { Runtime } from "./runtime.ts";
import { type Job, State } from "./state.ts";

interface TaskEvent {
  id: string;
  taskId: string;
  coworkerId?: string | null;
  actor?: { type: "user" | "coworker" | "sokoBot"; id: string };
  comment?: string | null;
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
    call: async () => {
      assert.fail("Task polling must enqueue work, not operate Herdr");
    },
    agents: async () => {
      assert.fail("Task polling must enqueue work, not inspect agents");
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
  function addTask(id: string, status = "READY", assigneeId = "codepat", userId = "alice") {
    tasks.set(id, { id, status, assigneeId, userId });
  }
  return {
    state,
    statePath,
    runtime,
    herdr,
    config,
    events,
    addTask,
    requestedCursors,
    requestedTasks,
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

test("follow-up events reuse the existing task conversation", async (t) => {
  const f = await fixture(t);
  f.addTask("task", "RUNNING");
  f.events.push(
    { id: "e1", taskId: "task", coworkerId: null },
    { id: "e2", taskId: "task", coworkerId: null },
  );
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  const jobs = f.state.all<Job>("jobs");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].conversationId, jobs[1].conversationId);
});

test("a user comment on a completed task wakes its existing conversation", async (t) => {
  const f = await fixture(t);
  f.addTask("task", "RUNNING");
  f.events.push({
    id: "initial-1",
    taskId: "task",
    actor: { type: "user", id: "alice" },
  });
  await f.runtime.pollTasks();
  const conversationId = f.state.all<Job>("jobs")[0].conversationId;
  f.addTask("task", "COMPLETED");
  f.events.push({
    id: "comment-1",
    taskId: "task",
    actor: { type: "user", id: "alice" },
    comment: "Where is the GitHub PR?",
  });
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  const jobs = f.state.all<Job>("jobs");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].taskId, "task");
  assert.equal(jobs[1].conversationId, conversationId);
  assert.match(jobs[1].input, /Where is the GitHub PR\?/);
  const receipt = f.state.get<{ jobId: string; text: string }>("taskInputs", "comment-1");
  assert.equal(receipt?.jobId, jobs[1].id);
  assert.equal(receipt?.text, "Where is the GitHub PR?");
  f.replay();
  const restarted = new Runtime(f.state, f.herdr, f.config);
  await restarted.pollTasks();
  assert.deepEqual(f.state.get("taskInputs", "comment-1"), receipt);
  assert.equal(f.state.all<Job>("jobs").length, 2);
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
  assert.deepEqual(f.requestedTasks, []);
});

test("comments on a consolidated duplicate are queued on the original", async (t) => {
  const f = await fixture(t);
  f.addTask("original", "RUNNING");
  f.addTask("duplicate", "CANCELED");
  f.state.put("taskRedirects", "duplicate", "original");
  f.events.push({ id: "followup", taskId: "duplicate", actor: { type: "user", id: "alice" }, comment: "Use this new requirement" });
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.all<Job>("jobs")[0].taskId, "original");
  assert.equal(f.state.get<{ taskId: string }>("taskInputs", "followup")?.taskId, "original");
});

test("an ownership change cannot reuse context or stall unrelated event intake", async (t) => {
  const f = await fixture(t);
  f.addTask("changed");
  f.events.push({ id: "initial", taskId: "changed" });
  await f.runtime.pollTasks();
  f.addTask("changed", "RUNNING", "codepat", "bob");
  f.addTask("other");
  f.events.push({ id: "changed-owner", taskId: "changed", comment: "New owner instruction" }, { id: "next", taskId: "other" });
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.get("meta", "taskCursor"), "next");
  assert.deepEqual(f.state.all<Job>("jobs").map(job => job.taskId), ["changed", "other"]);
  assert.equal(f.state.all("taskIntakeIssues").length, 1);
});

test("current actor metadata prevents self-authored comments from looping", async (t) => {
  const f = await fixture(t);
  f.addTask("task", "RUNNING");
  f.events.push({
    id: "self-actor-1",
    taskId: "task",
    actor: { type: "coworker", id: "codepat" },
    comment: "Still working",
  });
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.all("jobs").length, 0);
  assert.equal(f.state.get("meta", "taskCursor"), "self-actor-1");
});

test("a removed task advances the cursor without poisoning later events", async (t) => {
  const f = await fixture(t);
  f.addTask("accessible");
  f.events.push(
    { id: "gone-1", taskId: "removed", coworkerId: null },
    { id: "new-2", taskId: "accessible", coworkerId: null },
  );
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.deepEqual(
    f.state.all<Job>("jobs").map((job) => job.taskId),
    ["accessible"],
  );
  assert.equal(f.state.get("meta", "taskCursor"), "new-2");
  assert.equal(f.state.get("taskEvents", "gone-1"), true);
});

test("terminal or reassigned tasks never enqueue coordinator turns", async (t) => {
  const f = await fixture(t);
  f.addTask("done", "COMPLETED");
  f.addTask("canceled", "CANCELED");
  f.addTask("foreign", "RUNNING", "other-agent");
  f.events.push(
    { id: "t1", taskId: "done", coworkerId: null },
    { id: "t2", taskId: "canceled", coworkerId: null },
    { id: "t3", taskId: "foreign", coworkerId: null },
  );
  await f.runtime.pollTasks();
  assert.equal(f.runtime.pollError, undefined);
  assert.equal(f.state.all("jobs").length, 0);
  assert.equal(f.state.get("meta", "taskCursor"), "t3");
});
