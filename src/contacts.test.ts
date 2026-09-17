import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Contacts, ContactHttpError, contactOwnerApi, type ContactScope, type DirectSend } from "./contacts.ts";
import type { Api } from "./projects.ts";
import { Runtime } from "./runtime.ts";
import { createCodePatServer } from "./http.ts";
import { State, type Worker } from "./state.ts";

const scope = { userId: "requester", organizationId: "org-example" };
const roomId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const account = { ...scope, organizationSlug: "example", token: "synthetic-user-token" };
const recipient = { id: "recipient", name: "Avery Example", email: "avery@example.invalid" };
const self = { id: scope.userId, name: "Requester", email: "requester@example.invalid" };
const message = { query: recipient.email, text: "I'm CodePat. Here is the requested repository: https://example.invalid/repo" };
const room = () => ({ id: roomId, kind: "direct", organizationId: scope.organizationId,
  userMembers: [recipient], coworkerMembers: [{ id: "cow-example" }], sokoBotMembers: [] });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codepat-contacts-"));
  const state = new State(join(dir, "state.sqlite"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "synthetic-controller" }));
  const config = { dataDir: dir, cliPath: "cli.ts", repo: dir, apiUrl: "http://127.0.0.1:1", apiKey: "coworker_synthetic", coworkerId: "cow-example" };
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} }, config);
  const contacts = runtime.contacts;
  const calls: { path: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const owner: Api = async path => {
    if (path === "/users/me") return { data: self };
    if (path === `/chats/rooms/${roomId}`) return { data: room() };
    assert.equal(path, `/organizations/${scope.organizationId}/members`);
    return { data: [self, recipient].map(user => ({ organizationId: scope.organizationId, user })) };
  };
  const sender: Api = async (path, method, body, headers) => {
    calls.push({ path, method, body, headers });
    assert.equal(method, "POST");
    assert.deepEqual(headers, { "X-Context-User-Id": scope.userId, "X-Context-Organization-Id": scope.organizationId });
    if (path === "/chats/rooms") return { data: room() };
    assert.equal(path, `/chats/rooms/${roomId}/messages`);
    return { data: { id: "message-example", roomId, content: (body as { content: string }).content, sender: { type: "coworker", coworker: { id: "cow-example" } } } };
  };
  function wire(next: Contacts) { next.ownerApi = actual => { assert.deepEqual({ userId: actual.userId, organizationId: actual.organizationId }, scope); return owner; }; next.senderApi = () => sender; }
  wire(contacts);
  const conversation = runtime.createConversation(scope.userId, { sokosumi_organization_id: scope.organizationId });
  const job = runtime.createResponse(scope.userId, conversation.id, "Send an authorized message");
  runtime.nextJob();
  return { dir, state, config, runtime, contacts, calls, owner, sender, wire, job, conversation,
    close() { state.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("lookup supports names/exact email, paginated metadata and minimal results", async () => {
  const f = fixture();
  try {
    const seen: string[] = [];
    f.contacts.ownerApi = () => async path => {
      if (path === "/users/me") return { data: self };
      seen.push(path);
      const data = seen.length % 2 ? [self] : [recipient];
      return { data: data.map(user => ({ organizationId: scope.organizationId, user, lastSeenAt: "do-not-return", role: "member" })),
        meta: { pagination: { nextCursor: seen.length % 2 ? "next /?" : null } } };
    };
    assert.deepEqual(await f.contacts.lookup(scope, " aVeRy "), [recipient]);
    assert.match(seen[1], /cursor=next\+%2F%3F/);
    assert.deepEqual(await f.contacts.lookup(scope, "AVERY@example.invalid"), [recipient]);
    assert.deepEqual(await f.contacts.lookup(scope, "not@example.invalid"), []);
  } finally { f.close(); }
});

test("directory rejects wrong authenticated user, organization, nonmember and broken pagination", async () => {
  const f = fixture();
  try {
    for (const kind of ["user", "org", "membership", "repeated", "malformed", "disappeared"]) {
      let calls = 0;
      f.contacts.ownerApi = () => async path => {
        if (path === "/users/me") return { data: { id: kind === "user" ? "other" : scope.userId } };
        calls++;
        const users = kind === "membership" ? [recipient] : [self, recipient];
        return { data: users.map(user => ({ organizationId: kind === "org" ? "other" : scope.organizationId, user })),
          ...(["repeated", "malformed", "disappeared"].includes(kind) && !(kind === "disappeared" && calls > 1) ? { meta: { pagination: { nextCursor: kind === "malformed" ? 3 : "same" } } } : {}) };
      };
      await assert.rejects(f.contacts.lookup(scope, "Avery"), { name: "Error" }, kind);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("unknown and ambiguous recipients never create a room or message", async () => {
  const f = fixture();
  try {
    f.contacts.ownerApi = () => async path => path === "/users/me" ? { data: self } : { data: [self, recipient, { ...recipient, id: "second", email: "another@example.invalid" }].map(user => ({ organizationId: scope.organizationId, user })) };
    for (const query of ["No Such Person", "Avery"]) {
      f.contacts.queue(scope, query, { query, text: message.text });
      await f.contacts.deliver();
      const saved = f.contacts.get(scope, query);
      assert.equal(saved.status, "failed");
      assert.match(saved.error!, /not found|Ambiguous/);
      assert.equal(saved.retrySafe, true);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("durable key survives restart/new jobs, verifies ID and roster, sends only once", async () => {
  const f = fixture();
  try {
    const queued = f.contacts.queue(scope, "share-repo", { recipientId: recipient.id, text: message.text });
    assert.equal(queued.status, "queued");
    const restored = new Contacts(f.state, f.config); f.wire(restored);
    await Promise.all([restored.deliver(), restored.deliver()]);
    const accepted = restored.get(scope, "share-repo");
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.messageId, "message-example");
    assert.equal(accepted.id, queued.id);
    assert.deepEqual(f.calls[0].body, { kind: "direct", memberUserIds: [recipient.id] });
    assert.deepEqual(f.calls[1].body, { content: message.text, clientMessageId: queued.id });
    const again = new Contacts(f.state, f.config); f.wire(again);
    assert.equal(again.queue(scope, "share-repo", { recipientId: recipient.id, text: message.text }).status, "accepted");
    await again.deliver();
    assert.equal(f.calls.length, 2);
    assert.throws(() => again.retry(scope, "share-repo"), /must not be replayed/);
    assert.throws(() => again.queue(scope, "share-repo", { recipientId: recipient.id, text: "different" }), /different message/);
    assert.throws(() => again.get({ ...scope, userId: "other" }, "share-repo"), /No send/);
    assert.throws(() => again.get({ ...scope, organizationId: "other" }, "share-repo"), /No send/);
  } finally { f.close(); }
});

test("reject incorrect room roster, organization, sender, kind and unexpected destination", async () => {
  const f = fixture();
  try {
    const variants = [{ userMembers: [self] }, { userMembers: [recipient, self] }, { organizationId: "other" },
      { coworkerMembers: [{ id: "wrong-coworker" }] }, { sokoBotMembers: [{ id: "bot" }] }, { kind: "channel" }];
    for (const [index, variant] of variants.entries()) {
      f.contacts.senderApi = () => async path => { assert.equal(path, "/chats/rooms"); return { data: { ...room(), ...variant } }; };
      f.contacts.queue(scope, String(index), message);
      await f.contacts.deliver();
      assert.match(f.contacts.get(scope, String(index)).error!, /roster/);
    }
    f.contacts.ownerApi = () => async path => path.startsWith("/chats/rooms/") ? { data: { ...room(), id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" } } : f.owner(path);
    f.contacts.queue(scope, "existing", { ...message, roomId });
    await f.contacts.deliver();
    assert.match(f.contacts.get(scope, "existing").error!, /roster/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("verified existing room sends without room creation; unauthorized room read fails closed", async () => {
  const f = fixture();
  try {
    f.contacts.queue(scope, "existing", { ...message, roomId });
    await f.contacts.deliver();
    assert.equal(f.calls.length, 1);
    assert.equal(f.contacts.get(scope, "existing").status, "accepted");
    f.contacts.ownerApi = () => async path => { if (path.startsWith("/chats/rooms/")) throw new ContactHttpError(403); return f.owner(path); };
    f.contacts.queue(scope, "denied", { ...message, roomId });
    await f.contacts.deliver();
    assert.equal(f.contacts.get(scope, "denied").status, "failed");
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test("message POST ambiguity, 5xx, conflicts and malformed success are never replayed", async () => {
  const f = fixture();
  try {
    for (const [index, failure] of [new Error("connection lost"), new ContactHttpError(503), new ContactHttpError(409), null].entries()) {
      let posts = 0;
      f.contacts.senderApi = () => async path => {
        if (path === "/chats/rooms") return { data: room() };
        posts++;
        if (failure) throw failure;
        return { data: { id: "wrong-response" } };
      };
      f.contacts.queue(scope, String(index), message);
      await f.contacts.deliver();
      assert.equal(f.contacts.get(scope, String(index)).status, "uncertain");
      assert.equal(f.contacts.get(scope, String(index)).retrySafe, false);
      f.contacts.queue(scope, String(index), message);
      await f.contacts.deliver();
      assert.throws(() => f.contacts.retry(scope, String(index)), /must not be replayed/);
      assert.equal(posts, 1);
    }
  } finally { f.close(); }
});

test("known rejection permits only explicit retry with same clientMessageId and pinned recipient", async () => {
  const f = fixture();
  try {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      const ids: unknown[] = [];
      f.contacts.senderApi = () => async (path, method, body, headers) => {
        if (path === "/chats/rooms") return { data: room() };
        ids.push((body as { clientMessageId: string }).clientMessageId);
        if (ids.length === 1) throw new ContactHttpError(status);
        return f.sender(path, method, body, headers);
      };
      f.contacts.queue(scope, String(status), message);
      await f.contacts.deliver();
      assert.equal(f.contacts.get(scope, String(status)).status, "failed");
      await f.contacts.deliver();
      assert.equal(ids.length, 1);
      f.contacts.retry(scope, String(status));
      await f.contacts.deliver();
      assert.equal(f.contacts.get(scope, String(status)).status, "accepted");
      assert.equal(ids[0], ids[1]);
    }
  } finally { f.close(); }
});

test("restart at message intent is uncertain; room intent resumes create-or-get without duplicate message", async () => {
  const f = fixture();
  try {
    for (const stage of ["directory", "room", "message"] as const) {
      const item = f.contacts.queue(scope, stage, message);
      f.state.put("directSends", item.id, { ...item, status: "sending", stage });
    }
    const next = new Contacts(f.state, f.config); f.wire(next);
    assert.equal(next.get(scope, "message").status, "uncertain");
    assert.equal(next.get(scope, "room").status, "queued");
    await next.deliver();
    assert.equal(next.get(scope, "directory").status, "accepted");
    assert.equal(next.get(scope, "room").status, "accepted");
    assert.equal(f.calls.filter(c => c.path.endsWith("/messages")).length, 2);
  } finally { f.close(); }
});

test("missing credentials, invalid selectors and sender changes fail before external writes", async () => {
  const f = fixture();
  try {
    f.config.apiKey = "";
    assert.throws(() => f.contacts.queue(scope, "missing", message), /dedicated coworker/);
    f.config.apiKey = "admin-synthetic";
    assert.throws(() => f.contacts.queue(scope, "wrong", message), /dedicated coworker/);
    f.config.apiKey = "coworker_synthetic";
    assert.throws(() => f.contacts.queue(scope, "both", { ...message, recipientId: recipient.id }), /exactly one/);
    assert.throws(() => f.contacts.queue(scope, "invalid", { ...message, roomId: "../escape" }), /UUID/);
    assert.throws(() => f.contacts.queue(scope, "long", { ...message, text: "x".repeat(10001) }), /10000/);
    f.contacts.queue(scope, "changed", message); f.config.coworkerId = "new-coworker";
    await f.contacts.deliver();
    assert.match(f.contacts.get(scope, "changed").error!, /switch sender/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("runtime job control derives identity and rejects overrides/cross-job access/worker tokens", async () => {
  const f = fixture();
  let server: ReturnType<typeof createCodePatServer> | undefined;
  try {
    assert.deepEqual(await f.runtime.control("contacts", { jobId: f.job.id, query: "Avery" }), [recipient]);
    await assert.rejects(f.runtime.control("contacts", { jobId: f.job.id, query: "Avery", userId: "other" }), /Unsupported contact/);
    const other = f.runtime.createConversation("other", { sokosumi_organization_id: scope.organizationId });
    const otherJob = f.runtime.createResponse("other", other.id, "unrelated");
    const token = JSON.parse(readFileSync(f.runtime.scopedConfig({ kind: "job", id: f.job.id }), "utf8")).token;
    assert.equal(f.runtime.authorizeControl(token, "contacts", { jobId: otherJob.id }), false);
    f.state.put<Worker>("workers", "worker", { id: "worker", generation: 1 } as Worker);
    const workerToken = JSON.parse(readFileSync(f.runtime.scopedConfig({ kind: "worker", id: "worker", generation: 1 }), "utf8")).token;
    for (const action of ["contacts", "dm-send", "dm-status", "dm-retry"]) {
      assert.equal(f.runtime.authorizeControl(token, action, { jobId: f.job.id }), true);
      assert.equal(f.runtime.authorizeControl(workerToken, action, { jobId: f.job.id }), false);
    }
    assert.equal(f.runtime.authorizeControl(workerToken, "worker-result", { workerId: "worker" }), true);
    server = createCodePatServer({ organizationId: scope.organizationId, controlToken: "synthetic-master", service: f.runtime,
      authorizeControl: (...args) => f.runtime.authorizeControl(...args), control: (...args) => f.runtime.control(...args) });
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const action of ["contacts", "dm-send", "dm-status", "dm-retry"]) {
      const response = await fetch(`${base}/control/${action}`, { method: "POST", headers: { Authorization: `Bearer ${workerToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ jobId: f.job.id, key: "blocked", ...message }) });
      assert.equal(response.status, 401);
    }
    const accepted = await f.runtime.control("dm-send", { jobId: f.job.id, key: "allowed", ...message }) as DirectSend;
    assert.equal(accepted.status, "accepted");
    assert.equal((await f.runtime.control("dm-status", { jobId: f.job.id, key: "allowed" }) as DirectSend).id, accepted.id);
    f.runtime.completeJob(f.job.id, "done");
    assert.equal(f.runtime.authorizeControl(token, "contacts", { jobId: f.job.id }), false);
    await assert.rejects(f.runtime.control("contacts", { jobId: f.job.id, query: "Avery" }), /not active/);
  } finally { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); } f.close(); }
});

test("private owner account registry binds exact identity/org and validates file access", () => {
  const f = fixture();
  try {
    const registry = join(f.dir, "accounts.json"), owner = join(f.dir, "owner.json");
    const config = { ...f.config, contactAccountsFile: registry };
    assert.throws(() => contactOwnerApi(f.config, scope), /not configured/);
    writeFileSync(registry, JSON.stringify([{ ...scope, configPath: owner }]), { mode: 0o600 });
    writeFileSync(owner, JSON.stringify({ ...account, apiUrl: config.apiUrl }), { mode: 0o600 });
    assert.equal(typeof contactOwnerApi(config, scope), "function");
    assert.throws(() => contactOwnerApi(config, { ...scope, userId: "other" }), /Exactly one/);
    assert.throws(() => contactOwnerApi(config, { ...scope, organizationId: "other" }), /Exactly one/);
    chmodSync(owner, 0o644); assert.throws(() => contactOwnerApi(config, scope), /mode 600/); chmodSync(owner, 0o600);
    for (const variant of [{ userId: "other" }, { organizationId: "other" }, { token: "coworker_synthetic" }, { apiUrl: "https://elsewhere.invalid/v1" }]) {
      writeFileSync(owner, JSON.stringify({ ...account, apiUrl: config.apiUrl, ...variant }));
      assert.throws(() => contactOwnerApi(config, scope));
    }
  } finally { f.close(); }
});

test("real HTTP adapters keep user and coworker credentials separate and do not replay failed POST", async () => {
  const f = fixture();
  const requests: { url: string; token?: string }[] = [];
  let messagePosts = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ url: req.url!, token: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/users/me") return res.end(JSON.stringify({ data: self }));
    if (req.url === `/v1/organizations/${scope.organizationId}/members`) return res.end(JSON.stringify({ data: [self, recipient].map(user => ({ organizationId: scope.organizationId, user })) }));
    if (req.url === "/v1/chats/rooms") {
      assert.equal(req.headers["x-context-user-id"], scope.userId);
      assert.equal(req.headers["x-context-organization-id"], scope.organizationId);
      assert.deepEqual(body, { kind: "direct", memberUserIds: [recipient.id] });
      return res.end(JSON.stringify({ data: room() }));
    }
    messagePosts++;
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "untrusted upstream private diagnostic" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const owner = join(f.dir, "owner.json"), registry = join(f.dir, "accounts.json");
    writeFileSync(owner, JSON.stringify({ ...account, apiUrl: url }), { mode: 0o600 });
    writeFileSync(registry, JSON.stringify([{ ...scope, configPath: owner }]), { mode: 0o600 });
    const contacts = new Contacts(f.state, { ...f.config, apiUrl: url, contactAccountsFile: registry });
    contacts.queue(scope, "http", message); await contacts.deliver(); await contacts.deliver();
    assert.equal(contacts.get(scope, "http").status, "uncertain");
    assert.doesNotMatch(contacts.get(scope, "http").error!, /private diagnostic/);
    assert.equal(messagePosts, 1);
    for (const r of requests) assert.equal(r.token, r.url.includes("/chats/") ? "Bearer coworker_synthetic" : "Bearer synthetic-user-token");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); }
});

test("directory API failures stop before any room POST and missing config is actionable", async () => {
  const f = fixture();
  try {
    for (const status of [401, 403, 404, 429, 503]) {
      f.contacts.ownerApi = () => async () => { throw new ContactHttpError(status); };
      await assert.rejects(f.contacts.lookup(scope, "Avery"), new RegExp(String(status)));
      f.contacts.queue(scope, `directory-${status}`, message);
      await f.contacts.deliver();
      const saved = f.contacts.get(scope, `directory-${status}`);
      assert.equal(saved.status, "failed");
      assert.equal(saved.stage, "directory");
      assert.equal(saved.retrySafe, true);
    }
    const unconfigured = new Contacts(f.state, f.config);
    unconfigured.queue(scope, "no-account", message);
    await unconfigured.deliver();
    assert.match(unconfigured.get(scope, "no-account").error!, /not configured/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("retry never reroutes a resolved name after a room failure; recent context is scoped", async () => {
  const f = fixture();
  try {
    f.contacts.senderApi = () => async () => { throw new Error("Lost room response"); };
    f.contacts.queue(scope, "pinned", { query: "Avery", text: message.text });
    await f.contacts.deliver();
    assert.equal(f.contacts.get(scope, "pinned").recipient?.id, recipient.id);
    assert.equal(f.contacts.get(scope, "pinned").stage, "room");
    f.contacts.ownerApi = () => async path => path === "/users/me" ? { data: self } : { data: [self, { ...recipient, id: "replacement" }].map(user => ({ organizationId: scope.organizationId, user })) };
    f.contacts.retry(scope, "pinned");
    await f.contacts.deliver();
    assert.match(f.contacts.get(scope, "pinned").error!, /not found/);
    assert.deepEqual(f.contacts.recent({ ...scope, userId: "other" }), []);
    assert.deepEqual(f.contacts.recent({ ...scope, organizationId: "other" }), []);
    assert.equal(f.contacts.recent(scope)[0].key, "pinned");
    const next = f.runtime.nextJob("test");
    assert.equal((next?.context as { directMessages: { key: string }[] }).directMessages[0].key, "pinned");
  } finally { f.close(); }
});

test("corrupt account JSON cannot expose credential text through an error", () => {
  const f = fixture();
  try {
    const path = join(f.dir, "accounts.json");
    writeFileSync(path, 'unparseable synthetic-sensitive-content', { mode: 0o600 });
    assert.throws(() => contactOwnerApi({ ...f.config, contactAccountsFile: path }, scope), error => {
      assert.match(String(error), /inspect the private file/);
      assert.doesNotMatch(String(error), /synthetic-sensitive/);
      return true;
    });
  } finally { f.close(); }
});

test("CLI routes contact commands with scoped job and file content, without credential/identity overrides", async () => {
  const f = fixture();
  const requests: { route: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-cli-token");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ route: req.url!, body });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "queued" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const configPath = join(f.dir, "cli.json"), messagePath = join(f.dir, "message.txt");
    writeFileSync(configPath, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic-cli-token" }));
    writeFileSync(messagePath, message.text);
    const env = { ...process.env, CODEPAT_CONFIG: configPath, CODEPAT_JOB_ID: "synthetic-job" };
    const run = (...args: string[]) => promisify(execFile)(process.execPath, ["src/cli.ts", ...args], { env });
    await run("contacts", recipient.email);
    await run("dm-send", "share", "--to", recipient.email, "--file", messagePath);
    await run("dm-send", "existing", "--recipient", recipient.id, "--room", roomId, "--file", messagePath);
    await run("dm-status", "share"); await run("dm-retry", "share");
    await assert.rejects(run("dm-send", "bad", "--to", recipient.email));
    await assert.rejects(run("dm-send", "bad", "--to", recipient.email, "--recipient", recipient.id, "--file", messagePath));
    assert.deepEqual(requests, [
      { route: "/control/contacts", body: { jobId: "synthetic-job", query: recipient.email } },
      { route: "/control/dm-send", body: { jobId: "synthetic-job", key: "share", text: message.text, query: recipient.email } },
      { route: "/control/dm-send", body: { jobId: "synthetic-job", key: "existing", text: message.text, recipientId: recipient.id, roomId } },
      { route: "/control/dm-status", body: { jobId: "synthetic-job", key: "share" } },
      { route: "/control/dm-retry", body: { jobId: "synthetic-job", key: "share" } },
    ]);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.close(); }
});
