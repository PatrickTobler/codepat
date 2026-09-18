import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Runtime } from "./runtime.ts";
import { State, type Job, type Worker, type Outbox } from "./state.ts";
import { type Incident, Incidents } from "./incidents.ts";
import { createCodePatServer } from "./http.ts";
function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),"incidents-"));
  writeFileSync(join(dir,"client.json"),JSON.stringify({url:"http://localhost:1",token:"synthetic"}));
  const state=new State(join(dir,"state.sqlite"));
  const runtime=new Runtime(state,{call:async()=>({}),agents:async()=>[],prompt:async()=>{throw new Error("must not replay");}},{dataDir:dir,cliPath:"cli",repo:dir,apiUrl:"http://localhost:1",apiKey:"synthetic"});
  const c=runtime.createConversation("requester",{sokosumi_organization_id:"org",sokosumi_room_id:"room"});
  const worker={id:"worker",name:"example",conversationId:c.id,taskId:"task",repo:dir,worktree:dir,branch:"feature",prompt:"PRIVATE_PROMPT",state:"working",generation:1,createdAt:0,observedAt:0} as Worker;
  state.put("workers",worker.id,worker);
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  const claim=()=>runtime.nextJob("runner",1)!;
  return {dir,state,runtime,c,worker,claim};
}
test("worker result reaches orchestrator before user delivery, without error labeling",async t=>{
  const f=fixture(t);
  await f.runtime.control("worker-result",{workerId:f.worker.id,text:"PRIVATE_RAW_REPORT"});
  await f.runtime.control("worker-result",{workerId:f.worker.id,text:"PRIVATE_RAW_REPORT"});
  assert.equal(f.state.all("outbox").length,0); assert.equal(f.state.all("jobs").length,1);
  const next=f.claim();assert.equal(next.job.kind,"worker");
  f.runtime.completeJob(next.job.id,"The requested change is ready for review.");
  const chat=f.state.all<Outbox>("outbox").find(o=>o.path.startsWith("/chat-conversations"))!;
  assert.equal(chat.body.content,"The requested change is ready for review.");
  assert.doesNotMatch(JSON.stringify(chat),/PRIVATE_RAW_REPORT|Failure update/);
});
test("worker failure is sanitized, deduplicated and explained with task correlation",t=>{
  const f=fixture(t); f.worker.state="blocked";f.worker.error="PRIVATE_ERROR";f.state.put("workers",f.worker.id,f.worker);
  f.runtime.workerNotice(f.worker,"PRIVATE_ERROR");
  f.runtime.workerNotice(f.worker,"PRIVATE_ERROR");
  assert.equal(f.state.all("incidents").length,1);assert.equal(f.state.all("outbox").length,0);
  const next=f.claim();assert.equal(next.job.kind,"incident");assert.doesNotMatch(JSON.stringify(next.context),/PRIVATE/);
  f.runtime.completeJob(next.job.id,"The worker needs your approval. Its task remains blocked; inspect the requested decision.");
  const o=f.state.all<Outbox>("outbox")[0];
  assert.match(String(o.body.content),/CodePat — Work blocked/);assert.match(String(o.body.content),/https:\/\/app.sokosumi.com\/tasks\/task/);
  assert.equal(o.incidentIds?.length,1);assert.equal(f.state.get<Worker>("workers","worker")!.state,"blocked");
});
test("provider rejection creates incident; notification failure produces one honest fallback and no recursion",async t=>{
  const f=fixture(t);
  const j=f.state.enqueue({kind:"worker",conversationId:f.c.id,taskId:"task",input:"Assess report"});f.claim();
  f.runtime.completeJob(j.id,"PRIVATE_PROVIDER_BODY","provider_policy");
  assert.equal(f.runtime.job(j.id).text,"");assert.equal(f.state.all("outbox").length,0);
  const n=f.claim();assert.equal(n.job.kind,"incident");assert.match(JSON.stringify(n.context),/provider_policy/);
  for(const action of ["start","resume","dm-send","recover-chat","task-report"])await assert.rejects(f.runtime.control(action,{jobId:n.job.id}),/notification turns/);
  f.runtime.completeJob(n.job.id,"PRIVATE_SECOND_ERROR","provider_policy");
  assert.equal(f.state.all("incidents").length,1);assert.equal(f.state.all("outbox").length,1);
  assert.match(String(f.state.all<Outbox>("outbox")[0].body.content),/Automated system notice/);
  assert.doesNotMatch(JSON.stringify(f.state.all("outbox")),/PRIVATE/);
  f.runtime.incidents.schedule(Date.now()+10000000);assert.equal(f.runtime.nextJob("runner",1),null);
  assert.equal(f.runtime.incidents.pending(f.c).length,1);
});
test("chat priority, restart dedupe, cooldown and bounded incident batches",t=>{
  const f=fixture(t);
  for(let i=0;i<30;i++)f.runtime.incidents.record(f.c,{source:"turn",sourceId:String(i),kind:"failure",cause:"runner_error"});
  f.runtime.incidents.schedule(1000);f.runtime.incidents.schedule(1001);
  assert.equal(f.state.all<Job>("jobs").length,1);assert.equal(f.state.all<Job>("jobs")[0].incidentIds!.length,10);
  const restarted=new Incidents(f.state);restarted.schedule(1002);assert.equal(f.state.all("jobs").length,1);
  const chat=f.runtime.createResponse(f.c.owner,f.c.id,"A current user question");assert.equal(f.claim().job.id,chat.id);
  assert.equal(f.runtime.nextJob("other",1),null);f.runtime.completeJob(chat.id,"Answer");
  const notice=f.claim();f.runtime.completeJob(notice.job.id,"[NO_UPDATE]");
  restarted.schedule(1003);assert.equal(f.state.all<Job>("jobs").filter(j=>j.kind==="incident").length,1);
  restarted.schedule(Date.now()+300001);assert.equal(f.state.all<Job>("jobs").filter(j=>j.kind==="incident").length,2);
  assert.equal(f.runtime.incidents.context(f.c).pending.length,20);
});
test("cross-owner, workspace and conversation isolation includes pending delivery failures",async t=>{
  const f=fixture(t);const i=f.runtime.incidents.record(f.c,{source:"turn",sourceId:"one",kind:"failure",cause:"provider_policy"});
  for(const [owner,org] of [["other","org"],["requester","other"],["requester","org"]]){
    const c=f.runtime.createConversation(owner,{sokosumi_organization_id:org});
    const j=f.runtime.createResponse(owner,c.id,"Check work");const n=f.claim();assert.equal(n.job.id,j.id);
    assert.doesNotMatch(JSON.stringify(n.context),new RegExp(i.id));
    await assert.rejects(f.runtime.control("incident-report",{jobId:j.id,incidentId:i.id,kind:"failure",text:"leak"}),/not owned/);
    f.runtime.completeJob(j.id,"Answer");
  }
  const token=JSON.parse(readFileSync(f.runtime.scopedConfig({kind:"worker",id:f.worker.id,generation:1}),"utf8")).token;
  assert.equal(f.runtime.authorizeControl(token,"incident-report",{incidentId:i.id}),false);
});
test("delivery rejection and uncertain sends stay visible without notification feedback loops or blind retries",async t=>{
  const f=fixture(t);const i=f.runtime.incidents.record(f.c,{source:"worker",sourceId:"failed",kind:"blocked",cause:"worker_blocked",taskId:"task"});
  const j=f.claim();f.runtime.completeJob(j.job.id,"Work needs attention.");
  let posts=0;f.runtime.api=async()=>{posts++;throw new Error("PRIVATE_AMBIGUOUS");};
  await f.runtime.flushOutbox();assert.equal(posts,1);
  const o=f.state.all<Outbox>("outbox")[0];assert.equal(o.status,"uncertain");
  f.state.put("outbox",o.id,{...o,retryAt:0});await f.runtime.flushOutbox();assert.equal(posts,1);
  f.runtime.captureIncidents();assert.equal(f.state.all("incidents").length,1);
  assert.equal(f.runtime.incidents.context(f.c).pending[0].notifications[0].status,"uncertain");
  assert.doesNotMatch(JSON.stringify(f.runtime.incidents.context(f.c)),/PRIVATE_AMBIGUOUS/);
  f.state.put("outbox",o.id,{...o,status:"failed"});
  const chat=f.runtime.createResponse(f.c.owner,f.c.id,"Explain delivery");f.claim();
  await f.runtime.control("incident-report",{jobId:chat.id,incidentId:i.id,kind:"blocked",text:"Repeat"});
  assert.equal(f.state.all("outbox").length,1);
});
test("later authorized orchestrator can explain retained incident without replay; recovered notices distinct",async t=>{
  const f=fixture(t);const first=f.runtime.createResponse(f.c.owner,f.c.id,"Work");f.claim();
  f.runtime.completeJob(first.id,"PRIVATE","turn_exit_failure");
  const n=f.claim();f.runtime.completeJob(n.job.id,"PRIVATE","provider_policy");
  assert.equal(f.state.all("outbox").length,0); // original chat already received essential fallback
  const chat=f.runtime.createResponse(f.c.owner,f.c.id,"What happened?");f.claim();
  const i=f.runtime.incidents.pending(f.c)[0];
  await f.runtime.control("incident-report",{jobId:chat.id,incidentId:i.id,kind:"blocked",text:"The turn stopped; provider access needs review. Existing work remains tracked."});
  assert.equal(f.state.all("outbox").length,1);assert.equal(f.runtime.job(first.id).status,"failed");
  assert.equal(f.state.all("deliveries").length,0);
  f.runtime.completeJob(chat.id,"Explained");
  f.runtime.workerNotice(f.worker,"Restored same session","recovered");
  const rec=f.state.all<Incident>("incidents").find(i=>i.kind==="recovered")!;
  const later=f.runtime.createResponse(f.c.owner,f.c.id,"Check recovery");f.claim();
  await f.runtime.control("incident-report",{jobId:later.id,incidentId:rec.id,kind:"recovered",text:"The session is restored; completion still needs verification."});
  assert.match(String(f.state.all<Outbox>("outbox").at(-1)!.body.content),/CodePat — Recovery update/);
});
test("HTTP failure response labels bootstrap fallback and later delivery is authored by orchestrator",async t=>{
  const f=fixture(t);const server=createCodePatServer({service:f.runtime,organizationId:"org",controlToken:"synthetic",authorizeControl:f.runtime.authorizeControl.bind(f.runtime),control:f.runtime.control.bind(f.runtime)});
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();server.close();});
  const a=server.address();assert.ok(a && typeof a==="object");
  const job=f.runtime.createResponse(f.c.owner,f.c.id,"Inspect");f.claim();
  f.runtime.completeJob(job.id,"RAW_FAILURE","provider_policy");
  const response=await fetch(`http://127.0.0.1:${a.port}/v1/responses/${job.id}`,{headers:{"x-sokosumi-user-id":f.c.owner,"x-sokosumi-organization-id":"org"}});
  assert.equal(response.status,200);const body=await response.json() as any;
  assert.equal(body.status,"failed");assert.match(body.output_text,/Automated system notice/);assert.doesNotMatch(body.output_text,/RAW_FAILURE/);
  const jobsBefore=f.state.all("jobs").length;
  const wire=await (await fetch(`http://127.0.0.1:${a.port}/v1/responses/${job.id}?stream=true`,{headers:{"x-sokosumi-user-id":f.c.owner,"x-sokosumi-organization-id":"org"}})).text();
  assert.match(wire,/event: response.failed/);assert.match(wire,/Automated system notice/);
  assert.doesNotMatch(wire,/event: response.completed|RAW_FAILURE/);assert.equal(f.state.all("jobs").length,jobsBefore);
  const notification=f.claim();f.runtime.completeJob(notification.job.id,"The provider blocked this turn; the existing worker continues independently.");
  const sent:any[]=[];f.runtime.api=async(_p,m,b)=>{assert.equal(m,"POST");sent.push(b);return {data:{id:"accepted"}};};
  await f.runtime.flushOutbox();assert.equal(sent.length,1);assert.match(sent[0].content,/CodePat — Failure update/);
  assert.equal(f.state.all<Outbox>("outbox")[0].status,"sent");
});

test("actual HTTP422 delivery rejection is retained and original write never retried",async t=>{
  const f=fixture(t);
  const {createServer}=await import("node:http");
  let posts=0;const upstream=createServer((_req,res)=>{posts++;res.writeHead(422,{"content-type":"application/json"});res.end('{"error":"PRIVATE_REJECTION"}');});
  upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const a=upstream.address();assert.ok(a && typeof a==="object");f.runtime.config.apiUrl=`http://127.0.0.1:${a.port}`;
  f.runtime.reportTask("task","An orchestrator-authored update");
  await f.runtime.flushOutbox();await f.runtime.flushOutbox();assert.equal(posts,1);
  const original=f.state.all<Outbox>("outbox")[0];assert.equal(original.status,"failed");
  const n=f.claim();assert.equal(n.job.kind,"incident");assert.match(JSON.stringify(n.context),/delivery_failed/);assert.match(JSON.stringify(n.context),/"httpStatus":422/);assert.doesNotMatch(JSON.stringify(n.context),/PRIVATE_REJECTION/);
  f.runtime.completeJob(n.job.id,"The task update was rejected. Work remains tracked; the original update was not resent.");
  await f.runtime.flushOutbox();assert.equal(posts,2);
  f.runtime.captureIncidents();assert.equal(f.state.all("incidents").length,1);
  assert.equal(f.runtime.incidents.context(f.c).pending[0].notifications[0].status,"failed");
});
test("scope changes fence queued notifications; missing destinations stay observable",async t=>{
  const f=fixture(t);
  f.runtime.incidents.record(f.c,{source:"turn",sourceId:"x",kind:"failure",cause:"turn_exit_failure"});
  const n=f.claim();f.runtime.completeJob(n.job.id,"The process exited; cause is unknown.");
  f.c.owner="changed-owner";f.state.put("conversations",f.c.id,f.c);
  let calls=0;f.runtime.api=async()=>{calls++;return {};};await f.runtime.flushOutbox();
  assert.equal(calls,0);assert.equal(f.state.all<Outbox>("outbox")[0].status,"failed");
  assert.equal(f.runtime.incidents.context(f.c).total,0);
  const c=f.runtime.createConversation("another",{sokosumi_organization_id:"org"});
  const i=f.runtime.incidents.record(c,{source:"turn",sourceId:"missing",kind:"failure",cause:"runner_error"});
  const chat=f.runtime.createResponse(c.owner,c.id,"Explain");f.claim();
  await f.runtime.control("incident-report",{jobId:chat.id,incidentId:i.id,kind:"failure",text:"No background destination is available."});
  assert.equal(f.runtime.incidents.context(c).pending[0].notificationMissing,true);
});

test("lost completion/report acknowledgment and SQLite restart do not duplicate notices",async t=>{
  const f=fixture(t);const i=f.runtime.incidents.record(f.c,{source:"turn",sourceId:"one",kind:"failure",cause:"runner_error"});
  const n=f.claim();f.runtime.completeJob(n.job.id,"Known failure; next step is inspection.");
  f.runtime.completeJob(n.job.id,"Duplicate reply");
  const reopened=new State(join(f.dir,"state.sqlite"));
  const manager=new Incidents(reopened);manager.schedule(Date.now()+600000);
  assert.equal(reopened.all("outbox").length,1);assert.equal(reopened.all<Job>("jobs").filter(j=>j.status==="queued").length,0);reopened.close();
  const chat=f.runtime.createResponse(f.c.owner,f.c.id,"Explain");f.claim();
  await f.runtime.control("incident-report",{jobId:chat.id,incidentId:i.id,kind:"failure",text:"Duplicate report"});
  assert.equal(f.state.all("outbox").length,1);
});
test("monitor and native-send errors retain scoped metadata without exposing bodies",async t=>{
  const f=fixture(t);f.runtime.herdr.agents=async()=>{throw new Error("PRIVATE_MONITOR_BODY");};await f.runtime.monitor();
  assert.equal(f.state.all<Incident>("incidents")[0].cause,"monitor_unavailable");
  f.state.put("directSends","dm",{id:"dm",conversationId:f.c.id,userId:f.c.owner,organizationId:"org",status:"uncertain",request:{content:"PRIVATE_MESSAGE"}});
  f.state.put("directSends","other",{id:"other",conversationId:f.c.id,userId:"other",organizationId:"org",status:"failed"});
  f.runtime.captureIncidents();assert.equal(f.state.all("incidents").length,2);
  assert.doesNotMatch(JSON.stringify(f.runtime.incidents.context(f.c)),/PRIVATE|"other"/);
});
test("scope changed before claim cancels notification without exposing old incidents",t=>{
  const f=fixture(t);f.runtime.incidents.record(f.c,{source:"turn",sourceId:"one",kind:"failure",cause:"provider_policy"});
  f.runtime.incidents.schedule();f.c.metadata.sokosumi_organization_id="another";f.state.put("conversations",f.c.id,f.c);
  assert.equal(f.runtime.nextJob("runner",1),null);assert.equal(f.state.all("outbox").length,0);
});
test("pending context rotates instead of starving incidents behind unchanged failures",t=>{
  const f=fixture(t);for(let x=0;x<35;x++)f.runtime.incidents.record(f.c,{source:"turn",sourceId:String(x),kind:"failure",cause:"runner_error"});
  const a=f.runtime.incidents.context(f.c,true),b=f.runtime.incidents.context(f.c,true);
  assert.equal(new Set([...a.pending,...b.pending].map(i=>i.id)).size,35);
  assert.equal(a.total,35);assert.equal(a.pending.length,20);
});

test("an incident explanation cannot suppress unrelated required review stages",t=>{
  const f=fixture(t);f.worker.state="blocked";f.state.put("workers",f.worker.id,f.worker);
  f.state.put("workers","review-stage",{...f.worker,id:"review-stage",state:"completed"});
  f.state.put("reviewWork","review-stage",{workerId:"review-stage",state:"pending",note:"Required independent review remains"});
  f.runtime.reviews.schedule(0);
  const n=f.claim();assert.equal(n.job.kind,"incident");f.runtime.completeJob(n.job.id,"One worker is blocked.");
  assert.equal(f.runtime.reviews.status(f.c.id).schedule?.lastNotified,undefined);
  assert.equal(f.runtime.reviews.evidence(f.c).needed,true);
});
