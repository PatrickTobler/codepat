import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { auditTaskProjects } from "./task-projects.ts";
import { Runtime } from "./runtime.ts";
import { State, type Worker } from "./state.ts";
import type { Api } from "./projects.ts";
const project = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const scope = { userId: "requester", organizationId: "org-example" };
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, meta: { pagination: { nextCursor } } });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "task-project-audit-"));
  writeFileSync(join(dir, "client.json"), JSON.stringify({ url: "http://localhost:1", token: "synthetic" }));
  const state = new State(join(dir, "state.sqlite"));
  const runtime = new Runtime(state, { call: async () => ({}), agents: async () => [], prompt: async () => {} }, { dataDir: dir, cliPath: "cli", repo: dir, apiUrl: "http://localhost:1", coworkerId: "coworker" });
  const c = runtime.createConversation(scope.userId, { sokosumi_organization_id: scope.organizationId });
  const job = runtime.createResponse(scope.userId, c.id, "Audit owned tracked task assignments"); runtime.nextJob();
  const worker = { id: "worker", name: "example", conversationId: c.id, taskId: "task", repo: dir, worktree: dir, branch: "feature", prompt: "Authorized implementation", state: "completed", result: "Stage ready", createdAt: 0, observedAt: 0 } as Worker;
  state.put("workers", worker.id, worker);
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, state, runtime, c, job, worker };
}
function apiFixture(tasks: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const api: Api = async (path, method, body, headers) => {
    assert.equal(method, "GET"); assert.equal(body, undefined);
    assert.deepEqual(headers, { "X-Context-User-Id": scope.userId, "X-Context-Organization-Id": scope.organizationId });
    reads.push(path);
    if (path.startsWith("/projects?")) return page([{ id: project }, { id: other }]);
    if (path.startsWith("/projects/")) return { data: { id: path.split("/").at(-1) } };
    const id = decodeURIComponent(path.split("/").at(-1)!);
    if (!tasks[id]) throw new Error("403 private upstream payload must not leak");
    return { data: { id, ownerId: scope.userId, organizationId: scope.organizationId, name: "Synthetic task", ...tasks[id] } };
  };
  return { api, reads };
}

test("unique tracked tasks are deduplicated across reviewer workers; remote cache differences do not mutate anything", async t => {
  const f = fixture(t); f.state.put("workers", "reviewer", { ...f.worker, id: "reviewer", projectId: other });
  const remote = apiFixture({ task: { projectId: project } }); f.runtime.api = remote.api;
  const before = JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all());
  const result = await f.runtime.control("task-projects", { jobId: f.job.id, repository: f.dir, projectId: project }) as Awaited<ReturnType<typeof auditTaskProjects>>;
  assert.equal(result.uniqueTasks, 1); assert.equal(remote.reads.filter(p => p === "/tasks/task").length, 1);
  const live = result.rows[0].live; assert.ok(live.verified); assert.equal(live.cacheState, "differs"); assert.equal(live.expectedMatch, true);
  assert.equal(result.rows[0].workerIds.length, 2); assert.equal(JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all()), before);
});

test("missing cached field is unknown, only explicit remote null means unassigned; wrong live assignment is visible", async t => {
  const f = fixture(t);
  for (const value of [null, other, project]) {
    const result = await auditTaskProjects(apiFixture({ task: { projectId: value } }).api, [f.worker], scope, project);
    const live = result.rows[0].live; assert.ok(live.verified); assert.equal(live.projectId, value); assert.equal(live.cacheState, "unknown"); assert.equal(live.expectedMatch, value === project);
  }
  for (const task of [{}, { projectId: "invalid" }]) {
    const result = await auditTaskProjects(apiFixture({ task }).api, [f.worker], scope);
    assert.equal(result.rows[0].live.verified, false); assert.equal(result.complete, false);
  }
});

test("per-task access failures remain partial, never expose changed owner/workspace data", async t => {
  const f = fixture(t);
  for (const changes of [{ ownerId: "other" }, { organizationId: "other-org" }]) {
    const result = await auditTaskProjects(apiFixture({ task: { projectId: project, name: "PRIVATE_OTHER_TITLE", ...changes } }).api, [f.worker], scope);
    assert.equal(result.complete, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OTHER_TITLE/); assert.equal(result.rows[0].live.verified, false);
  }
  const result = await auditTaskProjects(apiFixture({ task: { projectId: project } }).api, [f.worker, { ...f.worker, id: "denied-worker", taskId: "denied" }], scope);
  assert.equal(result.uniqueTasks, 2); assert.equal(result.complete, false); assert.equal(result.rows[0].live.verified, true);
  assert.doesNotMatch(JSON.stringify(result), /private upstream/);
});

test("inventory isolates owned workspace/repository and rejects arbitrary task or identity overrides", async t => {
  const f = fixture(t); const calls = apiFixture({ task: { projectId: project } }); f.runtime.api = calls.api;
  for (const [owner, org] of [["different",scope.organizationId],[scope.userId,"different"]]) {
    const c = f.runtime.createConversation(owner,{sokosumi_organization_id:org}); f.state.put("workers",c.id,{...f.worker,id:c.id,taskId:c.id,conversationId:c.id});
  }
  f.state.put("workers","other-repo",{...f.worker,id:"other-repo",taskId:"other-repo",repo:"/different"});
  const result = await f.runtime.control("task-projects", {jobId:f.job.id,repository:f.dir}) as Awaited<ReturnType<typeof auditTaskProjects>>;
  assert.equal(result.uniqueTasks,1);assert.equal(calls.reads.filter(p=>p.startsWith("/tasks/")).length,1);
  for (const extra of [{taskId:"arbitrary"},{userId:"other"},{organizationId:"other"}]) await assert.rejects(f.runtime.control("task-projects",{jobId:f.job.id,...extra}),/Unsupported/);
  await assert.rejects(f.runtime.control("task-projects",{jobId:f.job.id,projectId:project}),/repository/);
  f.c.metadata={};f.state.put("conversations",f.c.id,f.c);
  await assert.rejects(f.runtime.control("task-projects",{jobId:f.job.id}),/sokosumi_organization_id/);
});

test("worker credentials deny inventory and only matching active job scope is accepted", t => {
  const f = fixture(t); const workerToken=JSON.parse(readFileSync(f.runtime.scopedConfig({kind:"worker",id:f.worker.id,generation:0}),"utf8")).token;
  assert.equal(f.runtime.authorizeControl(workerToken,"task-projects",{jobId:f.job.id}),false);
  const token=JSON.parse(readFileSync(f.runtime.scopedConfig({kind:"job",id:f.job.id}),"utf8")).token;
  assert.equal(f.runtime.authorizeControl(token,"task-projects",{jobId:f.job.id}),true);assert.equal(f.runtime.authorizeControl(token,"task-projects",{jobId:"other"}),false);
});

test("project pages are complete; closed/inaccessible targets and partial pages never appear valid", async t => {
  const f=fixture(t);const remote=apiFixture({task:{projectId:project}});let pages=0;
  const api:Api=async(path,...rest)=>path.startsWith("/projects?") ? (++pages%2===1?page([{id:other}],"next"):page([{id:project}])) : remote.api(path,...rest);
  const result=await auditTaskProjects(api,[f.worker],scope);assert.equal(result.projectInventoryVerified,true);assert.equal(pages,2);
  const closed:Api=async(path,...rest)=>path===`/projects/${project}`?{data:{id:project,closedAt:"now"}}:remote.api(path,...rest);
  await assert.rejects(auditTaskProjects(closed,[f.worker],scope,project),/closing/);
  const inaccessible:Api=async(path,...rest)=>path.startsWith("/projects?")?page([]):remote.api(path,...rest);
  await assert.rejects(auditTaskProjects(inaccessible,[f.worker],scope,project),/accessible/);
  const failed:Api=async(path,...rest)=>path.startsWith("/projects?")?page([{id:project}],"loop"):remote.api(path,...rest);
  const incomplete=await auditTaskProjects(failed,[f.worker],scope);assert.equal(incomplete.complete,false);assert.equal(incomplete.projectInventoryVerified,false);
});

test("retry after lost read response performs no writes, reports live changes without overwriting expected create project", async t => {
  const f=fixture(t);f.worker.projectId=project;f.worker.projectUnconfirmed=true;f.state.put("workers",f.worker.id,f.worker);
  const missing=await auditTaskProjects(apiFixture({}).api,[f.worker],scope);assert.equal(missing.complete,false);
  const remote=apiFixture({task:{projectId:other}}); const a=await auditTaskProjects(remote.api,[f.worker],scope);const b=await auditTaskProjects(remote.api,[f.worker],scope);
  assert.deepEqual(a.rows,b.rows);assert.equal(f.state.get<Worker>("workers",f.worker.id)!.projectId,project);
  assert.ok(a.rows[0].live.verified);assert.equal(a.rows[0].live.cacheState,"unconfirmed");
});

test("follow-up owner/workspace failures leave cache, completion outbox and instruction ledger unchanged", async t => {
  const f=fixture(t); f.runtime.reportTask("task","Finished stage","COMPLETED");
  const before=JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all());
  for (const change of [{ownerId:"another"},{organizationId:"another"}]) {
    f.runtime.api=async()=>({data:{id:"task",ownerId:scope.userId,organizationId:scope.organizationId,assigneeId:"coworker",status:"RUNNING",projectId:other,...change}});
    await assert.rejects(f.runtime.prepareFollowup(f.worker,"Continue"),/ownership|organization/);
    assert.equal(JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all()),before);
  }
  f.c.metadata={};f.state.put("conversations",f.c.id,f.c);let calls=0;f.runtime.api=async()=>{calls++;return {};};
  await assert.rejects(f.runtime.prepareFollowup(f.worker,"Continue"),/known requester organization/);assert.equal(calls,0);
});

test("malformed follow-up project response preserves pending completion and cached assignment", async t => {
  const f = fixture(t);
  f.worker.projectId = project; f.state.put("workers", f.worker.id, f.worker);
  f.runtime.reportTask("task", "Finished stage", "COMPLETED");
  const before = JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all());
  for (const field of [{}, {projectId: "invalid"}]) {
    f.runtime.api = async () => ({data: {ownerId: scope.userId, organizationId: scope.organizationId, assigneeId: "coworker", status: "RUNNING", ...field}});
    await assert.rejects(f.runtime.prepareFollowup(f.worker, "Continue"), /project/);
    assert.equal(JSON.stringify(f.state.db.prepare("select * from records order by kind,id").all()), before);
  }
});

test("live closed or inaccessible assignment remains visible without automatic correction", async t => {
  const f = fixture(t); const remote = apiFixture({task: {projectId: project}});
  for (const status of ["closed", "inaccessible"]) {
    const api: Api = async (path, ...rest) => status === "inaccessible" && path.startsWith("/projects?") ? page([])
      : path === `/projects/${project}` ? {data: {id: project, closedAt: "synthetic-date"}} : remote.api(path, ...rest);
    const result = await auditTaskProjects(api, [f.worker], scope);
    assert.ok(result.rows[0].live.verified);
    assert.equal(result.rows[0].live.projectState, status);
  }
});
