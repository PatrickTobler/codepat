import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrPort } from "./herdr.ts";
import { Runtime, type RuntimeConfig } from "./runtime.ts";
import { type Outbox, State, type Worker } from "./state.ts";

function fixture(config: Partial<RuntimeConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-reliability-"));
  const state = new State(join(dir, "state.sqlite"));
  const calls: string[][] = [];
  const herdr: HerdrPort = {
    call: async (args) => {
      calls.push(args);
      return args[0] === "tab"
        ? { root_pane: { pane_id: "w1:new" } }
        : { panes: [] };
    },
    agents: async () => [],
    prompt: async () => {},
  };
  const runtime = new Runtime(state, herdr, {
    dataDir: dir,
    cliPath: "cli.ts",
    repo: dir,
    apiUrl: "https://unused.invalid",
    apiKey: "test",
    coworkerId: "codepat",
    ...config,
  });
  return {
    dir,
    state,
    runtime,
    calls,
    herdr,
    close() {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("uncertain task delivery reconciles committed result without replay", async () => {
  const f = fixture();
  try {
    const conversation = f.runtime.createConversation("owner", {
      sokosumi_organization_id: "org",
    });
    f.state.put("taskConversations", "task-1", conversation.id);
    f.runtime.reportTask("task-1", "verified result", "COMPLETED");
    let posts = 0;
    let committed: unknown;
    f.runtime.api = async (path, method, body) => {
      if (method === "POST") {
        posts++;
        committed = body;
        throw new Error("response lost after commit");
      }
      return path.endsWith("/events")
        ? { data: [{ ...(committed as object), coworkerId: "codepat" }] }
        : { data: { ownerId: "owner", organizationId: "org", assigneeId: "codepat", status: "RUNNING" } };
    };
    await f.runtime.flushOutbox();
    const item = f.state.all<Outbox>("outbox")[0];
    assert.equal(item.status, "uncertain");
    item.retryAt = 0;
    f.state.put("outbox", item.id, item);
    await f.runtime.flushOutbox();
    assert.equal(posts, 1);
    assert.equal(f.state.get<Outbox>("outbox", item.id)?.status, "sent");
  } finally {
    f.close();
  }
});

test("missing worker resumes same worktree and task with reconciled instruction context", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const worktree = join(f.dir, "worker");
    mkdirSync(worktree);
    const w: Worker = {
      id: "worker-1",
      name: "cp-worker",
      prompt: "implement feature",
      repo: f.dir,
      worktree,
      branch: "codepat/worker",
      taskId: "task-1",
      conversationId: c.id,
      paneId: "w1:gone",
      state: "missing",
      generation: 1,
      createdAt: 0,
      observedAt: 0,
    };
    f.state.put("workers", w.id, w);
    f.state.put("meta", "workspace", "w1");
    f.runtime.queueInstruction(w, "add a regression test");
    f.runtime.api = async () => ({
      data: { assigneeId: "codepat", status: "READY" },
    });
    await f.runtime.recoverWorkers();
    const saved = f.state.get<Worker>("workers", w.id)!;
    assert.equal(saved.paneId, "w1:new");
    assert.equal(saved.taskId, "task-1");
    assert.equal(saved.worktree, worktree);
    assert.equal(saved.recoveryAttempts, 1);
    assert.equal(saved.state, "idle");
    assert.equal(f.state.all<Outbox>("outbox").length, 0); // session preparation is not prompt delivery
    assert.ok(
      f.calls.some(
        (args) => args.includes("resume") && args.includes("--last"),
      ),
    );
    assert.equal(f.state.all("workers").length, 1);
    const deliveries=f.state.all<{text:string;status:string;recoveryNotice?:boolean}>("deliveries");
    assert.equal(deliveries.length,1);
    assert.equal(deliveries[0].text,"add a regression test");
    assert.equal(deliveries[0].status,"queued");
    assert.equal(deliveries[0].recoveryNotice,true);
  } finally {
    f.close();
  }
});

test("repeated recovery failures stop instead of spawning forever", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const w: Worker = {
      id: "worker-1",
      name: "cp-worker",
      prompt: "work",
      repo: f.dir,
      worktree: f.dir,
      branch: "codepat/worker",
      taskId: "task-1",
      conversationId: c.id,
      state: "missing",
      createdAt: 0,
      observedAt: 0,
    };
    f.state.put("workers", w.id, w);
    f.runtime.api = async () => {
      throw new Error("temporary outage");
    };
    await f.runtime.recoverWorkers(1);
    await f.runtime.recoverWorkers(100_000);
    assert.equal(
      f.state.get<Worker>("workers", w.id)?.state,
      "recovery_blocked",
    );
    await f.runtime.monitor();
    await f.runtime.recoverWorkers(200_000);
    assert.equal(f.state.get<Worker>("workers", w.id)?.recoveryAttempts, 2);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("Claude workers launch and resume through Herdr with their original kind", async () => {
  const f = fixture();
  try {
    f.state.put("meta", "workspace", "w1");
    const w: Worker = {
      id: "claude-worker",
      name: "cp-claude",
      kind: "claude",
      prompt: "work",
      repo: f.dir,
      worktree: f.dir,
      branch: "branch",
      conversationId: "chat",
      state: "starting",
      createdAt: 0,
      observedAt: 0,
    };
    f.state.put("workers",w.id,w);
    await f.runtime.launchWorkerSession(w);
    let launch = f.calls.find((a) => a[0] === "agent")!;
    assert.equal(launch[launch.indexOf("--kind") + 1], "claude");
    assert.ok(!launch.includes("--continue"));
    assert.ok(!launch.includes("--no-alt-screen"));
    assert.ok(!launch.includes("danger-full-access"));
    f.calls.length = 0;
    w.paneId = undefined;
    f.state.put("workers",w.id,w);
    await f.runtime.launchWorkerSession(w, true);
    launch = f.calls.find((a) => a[0] === "agent")!;
    assert.equal(launch[launch.indexOf("--kind") + 1], "claude");
    assert.ok(launch.includes("--continue"));
    assert.equal(f.state.get<Worker>("workers", w.id)?.kind, "claude");
  } finally {
    f.close();
  }
});

test("Grok workers launch and resume through Herdr when installed", async () => {
  const f = fixture({ workerKinds: ["codex", "claude", "grok"] });
  try {
    f.state.put("meta", "workspace", "w1");
    const w: Worker = {
      id: "grok-worker",
      name: "cp-grok",
      kind: "grok",
      prompt: "work",
      repo: f.dir,
      worktree: f.dir,
      branch: "branch",
      conversationId: "chat",
      state: "starting",
      createdAt: 0,
      observedAt: 0,
    };
    f.state.put("workers", w.id, w);
    await f.runtime.launchWorkerSession(w);
    let launch = f.calls.find((a) => a[0] === "agent")!;
    assert.equal(launch[launch.indexOf("--kind") + 1], "grok");
    assert.equal(launch[launch.indexOf("--cwd") + 1], f.dir);
    assert.ok(launch.includes("--always-approve"));
    assert.ok(!launch.includes("--continue"));
    assert.ok(!launch.includes("danger-full-access"));
    f.calls.length = 0;
    w.paneId = undefined;
    f.state.put("workers", w.id, w);
    await f.runtime.launchWorkerSession(w, true);
    launch = f.calls.find((a) => a[0] === "agent")!;
    assert.ok(launch.includes("--continue"));
    assert.equal(f.state.get<Worker>("workers", w.id)?.kind, "grok");
  } finally {
    f.close();
  }
});

test("unsupported worker selection names the kinds installed on this host", async () => {
  const f = fixture({ workerKinds: ["codex"] });
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "work");
    await assert.rejects(
      f.runtime.startWorker(job, "work", "key", { kind: "claude" }),
      /Unsupported worker kind\. Available: codex$/,
    );
    assert.equal(f.state.all("workers").length, 0);
  } finally {
    f.close();
  }
});

test("unsupported worker selection fails before task or worker creation", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {});
    const job = f.runtime.createResponse("alice", c.id, "work");
    let requests = 0;
    f.runtime.api = async () => {
      requests++;
      return {};
    };
    await assert.rejects(
      f.runtime.startWorker(job, "work", "key", { kind: "grok" }),
      /Unsupported worker kind/,
    );
    assert.equal(requests, 0);
    assert.equal(f.state.all("workers").length, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("rate-limited task posts remain retryable without upstream idempotency", async () => {
  const f = fixture();
  let posts = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === "POST") posts++;
    res.writeHead(posts === 1 ? 429 : 201, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(posts === 1 ? { error: "rate_limited" } : { data: {} }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    f.runtime.config.apiUrl = `http://127.0.0.1:${address.port}`;
    f.runtime.reportTask("task", "progress");
    await f.runtime.flushOutbox();
    const item = f.state.all<Outbox>("outbox")[0];
    assert.equal(item.status, "pending");
    item.retryAt = 0;
    f.state.put("outbox", item.id, item);
    await f.runtime.flushOutbox();
    assert.equal(posts, 2);
    assert.equal(f.state.get<Outbox>("outbox", item.id)?.status, "sent");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

test("direct chat updates use existing room POST without resolver or history reads", async () => {
  const f = fixture();
  try {
    const c = f.runtime.createConversation("alice", {
      sokosumi_organization_id: "example-org",
      sokosumi_conversation_id: "room-1",
    });
    f.runtime.outbox(
      `/chat-conversations/${c.id}/messages`,
      { content: "result" },
      c.id,
    );
    let calls = 0;
    f.runtime.api = async (path, method, body, headers) => {
      calls++;
      assert.equal(method, "POST");
      assert.equal(path, "/chats/rooms/room-1/messages");
      assert.deepEqual(body, { content: "result" });
      assert.deepEqual(headers, {
        "X-Context-User-Id": "alice",
        "X-Context-Organization-Id": "example-org",
      });
      return { data: { id: "posted" } };
    };
    await f.runtime.flushOutbox();
    assert.equal(calls, 1);
    assert.equal(f.state.all<Outbox>("outbox")[0].status, "sent");
    assert.deepEqual(
      f.runtime.chatRoute({
        ...c,
        metadata: {
          sokosumi_room_id: "room-2",
          sokosumi_parent_message_id: "thread-1",
        },
      }),
      { roomId: "room-2", parentMessageId: "thread-1" },
    );
  } finally {
    f.close();
  }
});

test("ambiguous writes stay uncertain without unsupported idempotency or chat reads", async () => {
  const f = fixture();
  try {
    f.runtime.reportTask("task-1", "progress");
    f.runtime.outbox("/chats/rooms/room-1/messages", { content: "result" });
    let posts = 0;
    f.runtime.api = async (path, method, _body, headers) => {
      assert.equal(headers?.["Idempotency-Key"], undefined);
      if (method === "POST") {
        posts++;
        throw new Error("response lost");
      }
      assert.equal(path, "/tasks/task-1/events");
      return { data: [] };
    };
    await f.runtime.flushOutbox();
    for (const item of f.state.all<Outbox>("outbox")) {
      item.retryAt = 0;
      f.state.put("outbox", item.id, item);
    }
    await f.runtime.flushOutbox();
    assert.equal(posts, 2);
    for (const item of f.state.all<Outbox>("outbox")) {
      assert.equal(item.status, "uncertain");
      assert.match(item.lastError ?? "", /outcome is unconfirmed/);
    }
  } finally {
    f.close();
  }
});

test("thread correlation rejected as room leaves task result intact and never guesses another destination", async () => {
  const f = fixture();
  const paths: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    paths.push(req.url ?? "");
    res.writeHead(req.url?.startsWith("/tasks/") ? 201 : 404, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ data: {} }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    f.runtime.config.apiUrl = `http://127.0.0.1:${address.port}`;
    const c = f.runtime.createConversation("alice", {
      sokosumi_conversation_id: "thread-message",
    });
    f.runtime.reportTask("task-1", "verified result");
    f.runtime.outbox(
      `/chat-conversations/${c.id}/messages`,
      { content: "verified result" },
      c.id,
    );
    await f.runtime.flushOutbox();
    await f.runtime.flushOutbox();
    assert.deepEqual(paths, [
      "/tasks/task-1/events",
      "/chats/rooms/thread-message/messages",
    ]);
    const [task, chat] = f.state.all<Outbox>("outbox");
    assert.equal(task.status, "sent");
    assert.equal(chat.status, "failed");
    assert.match(chat.lastError ?? "", /Results remain on the Sokosumi task/);
    const status = (await f.runtime.control("status", {})) as {
      deliveryFailures: unknown[];
    };
    assert.equal(status.deliveryFailures.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
