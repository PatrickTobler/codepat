import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexProgress, MAX_PROGRESS, ProgressJournal } from "./progress.ts";
import { Runtime } from "./runtime.ts";
import { State } from "./state.ts";
import { createCodePatServer } from "./http.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-progress-"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://localhost:1", token: "test-controller" }));
  const state = new State(join(dir, "state.sqlite"));
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} },
    { dataDir: dir, cliPath: "cli.ts", repo: dir, apiUrl: "http://localhost:1" });
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  const conversation = runtime.createConversation("requester", { sokosumi_organization_id: "org-test" });
  const job = runtime.createResponse("requester", conversation.id, "Inspect the example", "one-request");
  const next = runtime.nextJob("runner-test")!;
  const token = JSON.parse(readFileSync(next.jobConfig, "utf8")).token as string;
  return { dir, state, runtime, job, conversation, token };
}
async function httpFixture(t: TestContext) {
  const f = fixture(t);
  const server = createCodePatServer({ service: f.runtime, organizationId: "org-test", controlToken: "test-controller",
    authorizeControl: f.runtime.authorizeControl.bind(f.runtime), control: f.runtime.control.bind(f.runtime) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "x-sokosumi-user-id": "requester", "x-sokosumi-organization-id": "org-test" };
  const post = (body: unknown, token = f.token) => fetch(`${base}/control/progress`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { ...f, base, headers, post };
}
function reader(response: Response) {
  const stream = response.body!.getReader(); let buffer = "";
  return { cancel: () => stream.cancel(), async next(): Promise<{ id: string; type: string; [key: string]: unknown }> {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data || data === "[DONE]") continue;
        return { ...JSON.parse(data), id: /^id: (.+)$/m.exec(frame)?.[1] };
      }
      const chunk = await stream.read(); assert.equal(chunk.done, false, "stream closed too early");
      buffer += new TextDecoder().decode(chunk.value);
    }
  } };
}

test("installed exec projection excludes private events and separates final from commentary", () => {
  const items: unknown[] = []; const projector = new CodexProgress(item => items.push(item), true);
  const ingest = (type: string, item: unknown) => projector.ingest(JSON.parse(JSON.stringify({ type, item })));
  ingest("item.completed", { id: "a", type: "agent_message", text: "I will check the example." });
  assert.equal(items.length, 0); // unmarked final/commentary still ambiguous
  ingest("item.started", { id: "b", type: "command_execution", command: "PRIVATE_ARGUMENT", aggregated_output: "PRIVATE_OUTPUT" });
  ingest("item.completed", { id: "c", type: "reasoning", text: "Checking the relevant files." }); // pinned upstream explicit summary
  ingest("reasoning.delta", { id: "d", text: "PRIVATE_REASONING" });
  ingest("item.completed", { id: "e", type: "analysis", text: "PRIVATE_ANALYSIS" });
  ingest("item.completed", { id: "f", type: "agent_message", phase: "analysis", text: "PRIVATE_PHASE" });
  ingest("item.completed", { id: "g", type: "agent_message", text: "Final answer only." });
  projector.finish();
  assert.equal(items.length, 3);
  assert.match(JSON.stringify(items), /I will check/);
  assert.doesNotMatch(JSON.stringify(items), /PRIVATE|Final answer/);
  ingest("item.started", { id: "b", type: "command_execution" });
  assert.equal(items.length, 3, "replayed exec event ignored");
});

test("public journal and runtime survive restart, deduplicate lost acknowledgments and bound storage", t => {
  const f = fixture(t); const path = join(f.dir, "progress.json");
  const journal = new ProgressJournal(path);
  for (let n = 0; n < MAX_PROGRESS + 10; n++) journal.append({ key: `item_${n}`, kind: "activity", text: "Checking the example" });
  assert.equal(new ProgressJournal(path).items.length, MAX_PROGRESS);
  f.runtime.recordProgress(f.job.id, journal.items);
  f.runtime.recordProgress(f.job.id, journal.items);
  const reopened = new State(join(f.dir, "state.sqlite"));
  assert.equal(reopened.get<unknown[]>("progress", f.job.id)!.length, MAX_PROGRESS); reopened.close();
  assert.throws(() => f.runtime.recordProgress(f.job.id, [{ ...journal.items[0], text: "Changed" }]), /conflict/);
  assert.throws(() => f.runtime.recordProgress(f.job.id, [{ key: "bad", kind: "analysis", text: "Private" }]), /Invalid/);
  f.runtime.completeJob(f.job.id, "Final");
  assert.throws(() => f.runtime.recordProgress(f.job.id, [{ key: "late", kind: "activity", text: "Late" }]), /not active/);
});

test("scoped ingestion reaches SSE BEFORE completion, then replay resumes without duplicate frames", { timeout: 5000 }, async t => {
  const f = await httpFixture(t);
  const response = await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers: f.headers });
  const stream = reader(response); assert.equal((await stream.next()).type, "response.created");
  const journal = new ProgressJournal(join(f.dir, "public-progress.json"));
  const projection = new CodexProgress(item => journal.append(item));
  projection.ingest({ type: "item.completed", item: { id: "intro", type: "agent_message", text: "I am checking the example." } });
  projection.ingest({ type: "item.started", item: { id: "tool", type: "command_execution", command: "not-for-publication" } });
  assert.equal((await f.post({ jobId: f.job.id, items: journal.items })).status, 200);
  const progress = await stream.next();
  assert.equal(progress.type, "response.reasoning_summary_text.delta");
  assert.match(String(progress.delta), /I am checking/);
  assert.equal(f.runtime.job(f.job.id).status, "in_progress", "progress is observable before reply exists");
  await stream.cancel();
  assert.equal(f.runtime.job(f.job.id).status, "in_progress");
  assert.equal((await f.post({ jobId: f.job.id, items: journal.items })).status, 200);
  const replay = reader(await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers: { ...f.headers, "Last-Event-ID": progress.id } }));
  const next = await replay.next(); assert.equal(next.type, "response.output_item.done");
  assert.notEqual(next.id, progress.id);
  assert.equal((await replay.next()).type, "response.reasoning_summary_text.delta");
  assert.equal((await replay.next()).type, "response.output_item.done");
  f.runtime.completeJob(f.job.id, "Only the final answer.");
  const final = await replay.next(); assert.equal(final.type, "response.output_text.delta"); assert.equal(final.delta, "Only the final answer.");
  assert.equal((await replay.next()).type, "response.completed"); await replay.cancel();
  assert.equal(f.state.all("jobs").length, 1);
  const json = await (await fetch(`${f.base}/v1/responses/${f.job.id}`, { headers: f.headers })).json() as { output_text: string };
  assert.equal(json.output_text, "Only the final answer.");
});

test("HTTP denies other jobs, worker tokens, owner/org leaks and mismatched/future cursors", async t => {
  const f = await httpFixture(t);
  const item = { key: "one", kind: "activity", text: "Checking" };
  assert.equal((await f.post({ jobId: "other", items: [item] })).status, 401);
  assert.equal((await f.post({ jobId: f.job.id, items: [item] }, "unrelated-worker-token")).status, 401);
  assert.equal((await f.post({ jobId: f.job.id, items: [item], userId: "other" })).status, 500);
  for (const headers of [{ ...f.headers, "x-sokosumi-user-id": "other" }, { ...f.headers, "x-sokosumi-organization-id": "other" }])
    assert.equal((await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers })).status, 403);
  for (const cursor of ["other:1", `${f.job.id}:999`, `${f.job.id}:NaN`])
    assert.equal((await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers: { ...f.headers, "Last-Event-ID": cursor } })).status, 400);
});

test("failure after progress emits a durable terminal and does not replace final with commentary", { timeout: 5000 }, async t => {
  const f = await httpFixture(t);
  f.runtime.recordProgress(f.job.id, [{ key: "one", kind: "activity", text: "Checking the example" }]);
  f.runtime.completeJob(f.job.id, "The turn stopped. Workers remain tracked.", "runner_error");
  const response = await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers: f.headers });
  const body = await response.text();
  assert.match(body, /response.failed/); assert.match(body, /runner_error/);
  assert.equal((body.match(/event: response.output_text.delta/g) ?? []).length, 1);
  const final = await fetch(`${f.base}/v1/responses`, { method: "POST", headers: { ...f.headers, "Idempotency-Key": "one-request" }, body: JSON.stringify({ conversation: f.conversation.id, input: "Inspect the example", stream: false }) });
  assert.equal((await final.json() as {status: string}).status, "failed");
  assert.equal(f.state.all("jobs").length, 1);
});

test("unknown Codex versions do not export opaque reasoning; explicit final phases are excluded", () => {
  const values: unknown[] = []; const projection = new CodexProgress(item => values.push(item));
  projection.ingest({ type: "item.completed", item: { id: "reason", type: "reasoning", text: "Opaque reasoning" } });
  projection.ingest({ type: "item.completed", item: { id: "comment", type: "agent_message", phase: "commentary", text: "Checking the example" } });
  projection.ingest({ type: "item.completed", item: { id: "final", type: "agent_message", phase: "final_answer", text: "Final answer" } });
  assert.deepEqual(values, [{ key: "comment:item.completed", kind: "commentary", text: "Checking the example" }]);
});

test("POST retry with stable key reuses the durable job and terminal cursor emits no duplicate events", async t => {
  const f = await httpFixture(t);
  f.runtime.completeJob(f.job.id, "Done");
  const post = (headers: Record<string, string>) => fetch(`${f.base}/v1/responses`, {
    method: "POST", headers: { ...f.headers, ...headers },
    body: JSON.stringify({ conversation: f.conversation.id, input: "Inspect the example", stream: true }),
  });
  const replay = await post({ "Idempotency-Key": "one-request", "Last-Event-ID": `${f.job.id}:2` });
  assert.equal(await replay.text(), "data: [DONE]\n\n");
  assert.equal(f.state.all("jobs").length, 1);
  assert.equal((await post({ "Last-Event-ID": `${f.job.id}:2` })).status, 400);
  assert.equal((await post({ "Idempotency-Key": "wrong-key", "Last-Event-ID": `${f.job.id}:2` })).status, 400);
  assert.equal(f.state.all("jobs").length, 1, "an invalid replay must not reserve new work");
});

test("a real worker reporting scope cannot inject progress, and recovery retains public journal before failure", async t => {
  const f = await httpFixture(t);
  f.state.put("workers", "worker-example", { generation: 1 });
  const config = f.runtime.scopedConfig({ kind: "worker", id: "worker-example", generation: 1 });
  const token = JSON.parse(readFileSync(config, "utf8")).token as string;
  assert.equal((await f.post({ jobId: f.job.id, items: [] }, token)).status, 401);
  const path = join(f.dir, "journal.json");
  const journal = new ProgressJournal(path);
  journal.append({ key: "public", kind: "activity", text: "Checking files" });
  f.runtime.recordProgress(f.job.id, new ProgressJournal(path).items);
  f.runtime.completeJob(f.job.id, "Runner stopped", "runner_error");
  const wire = await (await fetch(`${f.base}/v1/responses/${f.job.id}?stream=true`, { headers: f.headers })).text();
  assert.ok(wire.indexOf("Checking files") < wire.indexOf("response.failed"));
  assert.equal(f.runtime.authorizeControl(f.token, "progress", { jobId: f.job.id }), false);
});
