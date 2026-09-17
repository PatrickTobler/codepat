import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProject, pages, reassignOwnedTask, userApi, type Api } from "./projects.ts";
import { Runtime } from "./runtime.ts";
import { State, type Worker } from "./state.ts";
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const config = { userId: "alice", organizationId: "org", organizationSlug: "example" };
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, meta: { pagination: { nextCursor } } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codepat-projects-"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "synthetic" }));
  const state = new State(join(dir, "state.sqlite"));
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} }, { dataDir: dir, cliPath: "cli.ts", repo: dir, apiUrl: "http://127.0.0.1:1", coworkerId: "cow" });
  const c = runtime.createConversation("alice", { sokosumi_organization_id: "org" });
  const job = runtime.createResponse("alice", c.id, "code");
  runtime.nextJob();
  return { dir, state, runtime, c, job, close() { state.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("project pagination keeps context and does not truncate; repeated/missing cursors fail", async () => {
  const headers = { "X-Context-User-Id": "alice", "X-Context-Organization-Id": "org" };
  const seen: string[] = [];
  const api: Api = async (path, method, body, actual) => {
    assert.deepEqual(actual, headers);
    assert.equal(method, "GET");
    seen.push(path);
    return seen.length === 1 ? page([{ id: other }], "next /?") : page([{ id }]);
  };
  assert.equal((await pages(api, "/projects", headers)).length, 2);
  assert.match(seen[1], /cursor=next\+%2F%3F/);
  await assert.rejects(pages(async () => page([], "same"), "/projects", headers), /repeated/);
  await assert.rejects(pages(async () => ({ data: [] }), "/projects", headers), /Expected an object|pagination/);
});

test("project inspection rejects invalid/inaccessible/closing projects and upstream errors", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(inspectProject(async () => { throw new Error(`HTTP ${status}`); }, id, {}), new RegExp(String(status)));
  }
  await assert.rejects(inspectProject(async () => page([]), "../escape", {}), /UUID/);
  await assert.rejects(inspectProject(async () => page([]), id, {}), /not accessible/);
  await assert.rejects(inspectProject(async p => p.startsWith("/projects?") ? page([{ id }]) : { data: { id, closingAt: "now" } }, id, {}), /closing/);
});

test("coordinator project operations bind requesting identity; worker scopes cannot use them", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "client.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "synthetic" }));
    f.runtime.api = async (_p, _m, _b, h) => { assert.deepEqual(h, { "X-Context-User-Id": "alice", "X-Context-Organization-Id": "org" }); return page([{ id }]); };
    assert.equal((await f.runtime.control("projects", { jobId: f.job.id }) as unknown[]).length, 1);
    const token = JSON.parse(readFileSync(f.runtime.scopedConfig({ kind: "job", id: f.job.id }), "utf8")).token;
    assert.equal(f.runtime.authorizeControl(token, "projects", { jobId: f.job.id }), true);
    assert.equal(f.runtime.authorizeControl(token, "projects", { jobId: "other" }), false);
    const workerToken = JSON.parse(readFileSync(f.runtime.scopedConfig({ kind: "worker", id: "worker", generation: 1 }), "utf8")).token;
    assert.equal(f.runtime.authorizeControl(workerToken, "projects", { jobId: f.job.id }), false);
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key"), /UUID/);
    assert.equal(f.state.all("workers").length, 0);
    f.runtime.api = async () => { throw new Error("403"); };
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key", { projectId: id }), /403/);
    assert.equal(f.state.all("workers").length, 0);
  } finally { f.close(); }
});

test("existing task project is preserved; other owner/org and explicit replacement are rejected", async () => {
  const f = fixture();
  try {
    f.job.taskId = "task";
    f.runtime.api = async () => ({ data: { id: "task", ownerId: "bob", organizationId: "org", assigneeId: "cow", status: "READY", projectId: id } });
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key"), /ownership/);
    f.runtime.api = async () => ({ data: { id: "task", ownerId: "alice", organizationId: "elsewhere", assigneeId: "cow", status: "READY", projectId: id } });
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key"), /organization/);
    f.runtime.api = async () => ({ data: { id: "task", ownerId: "alice", organizationId: "org", assigneeId: "cow", status: "READY", projectId: id } });
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key", { projectId: other }), /different project/);
    f.runtime.inspectProject = async (_job, selected) => { assert.equal(selected, id); return { id }; };
    const result = await f.runtime.startWorker(f.job, "code", "key");
    assert.equal(result.taskId, "task");
    assert.equal(result.projectId, id);
    // Missing git repository prevents launch, while reservation retains identity.
    assert.equal(result.state, "launch_failed");
    assert.equal((await f.runtime.startWorker(f.job, "code", "key")).id, result.id);
    await assert.rejects(f.runtime.startWorker(f.job, "code", "key", { projectId: other }), /Stable operation/);
  } finally { f.close(); }
});

test("create retains task identity if upstream drops projectId", async () => {
  const f = fixture();
  try {
    const w = { id: "worker", conversationId: f.c.id, prompt: "test", projectId: id } as Worker;
    f.runtime.api = async (_p, _m, body) => { assert.equal((body as { projectId: string }).projectId, id); return { data: { id: "task", status: "READY" } }; };
    await assert.rejects(f.runtime.createWorkerTask(w, f.job, "test"), /retain projectId/);
    assert.equal(w.taskId, "task");
    assert.equal(w.projectUnconfirmed, true);
    assert.throws(() => f.runtime.confirmWorkerProject(w, { projectId: null }), /unconfirmed/);
    f.runtime.confirmWorkerProject(w, { projectId: id });
    assert.equal(w.projectUnconfirmed, false);
    assert.equal(f.state.get<Worker>("workers", "worker")?.taskId, "task");
  } finally { f.close(); }
});

function ownerApi(options: { owner?: string; org?: string; fail?: boolean; commit?: boolean } = {}) {
  let project: string | null = null;
  let writes = 0;
  const task = () => ({ id: "task", ownerId: options.owner ?? "alice", organizationId: options.org ?? "org", projectId: project });
  const api: Api = async (path, method, body, headers) => {
    assert.deepEqual(headers, { "X-Organization-Slug": "example" });
    if (path.startsWith("/tasks?")) { assert.match(path, /scope=owned/); return page([task()]); }
    if (path.startsWith("/projects?")) return page([{ id }]);
    if (path === `/projects/${id}`) return { data: { id } };
    assert.equal(path, "/tasks/task");
    if (method === "PATCH") {
      writes++;
      assert.deepEqual(body, { projectId: id });
      if (!options.fail || options.commit) project = id;
      if (options.fail) throw new Error("HTTP 403 or lost response");
    }
    return { data: task() };
  };
  return { api, writes: () => writes };
}

test("owner reassignment preserves task identity and reconciles lost responses without repeating PATCH", async () => {
  for (const options of [{}, { fail: true, commit: true }]) {
    const f = ownerApi(options);
    assert.equal((await reassignOwnedTask(f.api, config, "task", id)).verified, true);
    assert.equal((await reassignOwnedTask(f.api, config, "task", id)).changed, false);
    assert.equal(f.writes(), 1);
  }
});

test("owner reassignment fails closed on ownership, org, access and failed writes", async () => {
  for (const options of [{ owner: "bob" }, { org: "other" }, { fail: true }]) {
    const f = ownerApi(options);
    await assert.rejects(reassignOwnedTask(f.api, config, "task", id));
    assert.equal(f.writes(), options.fail ? 1 : 0);
  }
  await assert.rejects(reassignOwnedTask(async () => page([]), config, "task", id), /owned tasks/);
  assert.throws(() => userApi({ token: "coworker_synthetic" }), /owner/);
});

test("owner HTTP transport retries safe reads only and reports auth/rate-limit failures", async () => {
  let count = 0;
  let status = 503;
  const server = createServer((_req, res) => { count++; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [] })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as { port: number };
    const api = userApi({ token: "synthetic-user", apiUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(api("/projects"), /503/);
    assert.equal(count, 3);
    count = 0; status = 429;
    await assert.rejects(api("/tasks/task", "PATCH", { projectId: id }), /429/);
    assert.equal(count, 1);
    count = 0; status = 403;
    await assert.rejects(api("/projects"), /403/);
    assert.equal(count, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
