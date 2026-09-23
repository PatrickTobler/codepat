import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrPort } from "./herdr.ts";
import { Runtime, type RuntimeConfig } from "./runtime.ts";
import { type Outbox, State } from "./state.ts";

function fixture(config: Partial<RuntimeConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-reliability-"));
  const state = new State(join(dir, "state.sqlite"));
  const herdr: HerdrPort = {
    call: async () => ({}),
    agents: async () => [],
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

test("ambiguous writes stay uncertain without unsupported idempotency headers", async () => {
  const f = fixture();
  try {
    f.runtime.reportTask("task-1", "progress");
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
    assert.equal(posts, 1);
    for (const item of f.state.all<Outbox>("outbox")) {
      assert.equal(item.status, "uncertain");
      assert.match(item.lastError ?? "", /outcome is unconfirmed/);
    }
  } finally {
    f.close();
  }
});

test("a status transition blocked behind an unresolved earlier report stays pending", async () => {
  const f = fixture();
  try {
    const conversation = f.runtime.createConversation("owner", {
      sokosumi_organization_id: "org",
    });
    f.runtime.reportTask("task-1", "first", undefined, conversation.id);
    f.runtime.reportTask("task-1", "second", "COMPLETED", conversation.id);
    f.runtime.api = async (path, method) => {
      if (method === "POST") throw new Error("response lost");
      assert.equal(path, "/tasks/task-1/events");
      return { data: [] };
    };
    await f.runtime.flushOutbox();
    const [first, second] = f.state.all<Outbox>("outbox");
    assert.equal(first.status, "uncertain");
    assert.equal(second.status, "pending");
    assert.match(second.blockedReason ?? "", /unresolved delivery outcome/);
  } finally {
    f.close();
  }
});
