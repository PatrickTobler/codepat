import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {Runtime} from './runtime.ts';import {State,type Worker,type Outbox,type Delivery} from './state.ts';
import type {Incident} from './incidents.ts';
function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'review-fixes-'));writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://localhost:1',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));let prompts=0;
  const runtime=new Runtime(state,{call:async()=>({}),agents:async()=>[{pane_id:'pane',name:'worker',cwd:dir,agent_status:'idle'}],prompt:async()=>{prompts++;}}, {dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://api.invalid',apiKey:'synthetic',coworkerId:'coworker'});
  const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'worker',conversationId:c.id,repo:dir,worktree:dir,branch:'feature',prompt:'work',paneId:'pane',state:'completed',result:'Retained result',generation:1,createdAt:0,observedAt:0};state.put('workers',w.id,w);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;state.close();rmSync(dir,{recursive:true,force:true});});
  state.put('taskConversations','task',c.id);
  const job=state.enqueue({kind:'task',conversationId:c.id,taskId:'task',input:'Report'});runtime.nextJob();
  return {dir,state,runtime,c,w,job,prompts:()=>prompts};
}
test('ordered concurrent reports deliver both comments with one transition; retry returns current status',async t=>{
  const f=fixture(t);let status='READY';const posts:Record<string,unknown>[]=[];
  globalThis.fetch=async(_url,init)=>{
    if(init?.method==='POST'){
      const b=JSON.parse(String(init.body));posts.push(b);
      if(b.status===status)return new Response(JSON.stringify({message:'Invalid status transition: same status'}),{status:422});
      if(b.status)status=b.status;return Response.json({data:{}},{status:201});
    }return Response.json({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status}});
  };
  const report=(text:string)=>f.runtime.control('task-report',{jobId:f.job.id,text,status:'RUNNING'}) as Promise<{notificationId:string;status:string;accepted:boolean;ok:boolean}>;
  const [a,b]=await Promise.all([report('First'),report('Second')]);assert.equal(a.status,'pending');assert.equal(b.accepted,false);
  await Promise.all([f.runtime.flushOutbox(),f.runtime.flushOutbox()]);
  assert.equal(posts.length,2);assert.equal(posts.filter(p=>p.status==='RUNNING').length,1);
  assert.equal((await report('Second')).status,'sent');assert.equal((await report('Second')).accepted,true);
  await f.runtime.flushOutbox();assert.equal(posts.length,2);
});
test('failed predecessor is not assumed accepted; uncertain predecessor blocks later distinct reports',async t=>{
  for(const outcome of ['failed','uncertain']){
    const f=fixture(t);const posts:unknown[]=[];let first=true;
    globalThis.fetch=async(_url,init)=>{
      if(init?.method==='POST'){
        posts.push(JSON.parse(String(init.body)));
        if(first){first=false;if(outcome==='uncertain')throw new Error('lost');return new Response(JSON.stringify({message:'Invalid status transition: same status'}),{status:422});}
        return Response.json({data:{}},{status:201});
      }return Response.json({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'READY'}});
    };
    const a=await f.runtime.control('task-report',{jobId:f.job.id,text:'First',status:'RUNNING'}) as {notificationId:string};
    const b=await f.runtime.control('task-report',{jobId:f.job.id,text:'Second',status:'RUNNING'}) as {notificationId:string};
    await f.runtime.flushOutbox();
    const retry=await f.runtime.control('task-report',{jobId:f.job.id,text:'First',status:'RUNNING'}) as {ok:boolean;status:string;rejectionKind:string};
    if(outcome==='failed'){
      assert.equal(retry.ok,true);assert.equal(retry.status,'pending');assert.equal(retry.rejectionKind,'same_status');
      await f.runtime.flushOutbox();assert.equal(posts.length,3);assert.equal(f.state.get<Outbox>('outbox',a.notificationId)!.status,'sent');
      assert.equal(f.state.get<Outbox>('outbox',b.notificationId)!.status,'sent');
    } else {assert.equal(retry.ok,false);assert.equal(retry.status,outcome);}
    if(outcome==='uncertain'){assert.equal(posts.length,1);assert.equal(f.state.get<Outbox>('outbox',b.notificationId)!.status,'pending');assert.match(f.state.get<Outbox>('outbox',b.notificationId)!.blockedReason!,/unresolved/);}
    if(outcome==='uncertain') assert.equal(f.state.get<Outbox>('outbox',a.notificationId)!.status,outcome);
  }
});
test('reconciliation GET/local errors never replace POST failure diagnostics',async t=>{
  const f=fixture(t);const id=f.runtime.reportTask('task','Report');
  f.state.put('outbox',id,{...f.state.get<Outbox>('outbox',id)!,status:'uncertain',httpStatus:503,rejectionKind:undefined});
  globalThis.fetch=async()=>new Response('{}',{status:403});await f.runtime.flushOutbox();
  let d=f.state.get<Outbox>('outbox',id)!;assert.equal(d.httpStatus,503);assert.equal(d.reconciliationHttpStatus,403);
  f.state.put('outbox',id,{...d,retryAt:0});f.runtime.outboxWasDelivered=async()=>false;await f.runtime.flushOutbox();
  d=f.state.get<Outbox>('outbox',id)!;assert.equal(d.httpStatus,503);assert.equal(d.status,'uncertain');
});
test('transient delivery failure does not schedule a stale notice after acceptance',async t=>{
  const f=fixture(t);let n=0;globalThis.fetch=async()=>++n===1?new Response('{}',{status:429}):Response.json({data:{}},{status:201});
  const id=f.runtime.reportTask('task','Report');let d=f.state.get<Outbox>('outbox',id)!;d.conversationId=f.c.id;f.state.put('outbox',id,d);
  await f.runtime.flushOutbox();f.runtime.captureIncidents();assert.equal(f.state.all('incidents').length,0);
  // Regression for an old persisted transient incident/reserved notification job.
  const incident=f.runtime.incidents.record(f.c,{source:'delivery',sourceId:'outbox:'+id,kind:'blocked',cause:'delivery_failed',httpStatus:429});
  f.runtime.incidents.schedule();d=f.state.get<Outbox>('outbox',id)!;f.state.put('outbox',id,{...d,retryAt:0});await f.runtime.flushOutbox();f.runtime.captureIncidents();
  assert.equal(f.state.get<Outbox>('outbox',id)!.status,'sent');assert.ok(f.state.get<Incident>('incidents',incident.id)!.resolvedAt);
  assert.equal(f.runtime.incidents.pending(f.c).length,0);assert.equal(f.runtime.incidents.context(f.c).pending.length,0);
});
test('failure and blocked report evidence is not silently truncated',async t=>{
  const f=fixture(t);f.runtime.assertAssigned=async()=>({status:'RUNNING'});
  for(const status of ['FAILED','INPUT_REQUIRED','APPROVAL_REQUIRED','AWAITING_EXTERNAL']){
    const result=await f.runtime.control('task-report',{jobId:f.job.id,status,text:'x'.repeat(6000)+'TAIL-EVIDENCE'}) as {notificationId:string};
    assert.match(String(f.state.get<Outbox>('outbox',result.notificationId)!.body.comment),/TAIL-EVIDENCE/);
  }
});
test('dispatch crash rolls back generation/result and sending as one transaction',async t=>{
  const f=fixture(t);const d=f.runtime.queueInstruction(f.w,'Next');const put=f.state.put.bind(f.state);
  f.state.put=(kind,id,value)=>{put(kind,id,value);if(kind==='workers' && (value as Worker).state==='working')throw new Error('synthetic crash');};
  await f.runtime.deliver();f.state.put=put;
  const saved=f.state.get<Worker>('workers',f.w.id)!;assert.equal(saved.result,'Retained result');assert.equal(saved.generation,1);
  assert.equal(f.state.get<Delivery>('deliveries',d.id)!.status,'queued');assert.equal(f.prompts(),0);
});
test('resolved delivery suppresses unattempted stale notice but retains uncertain notice evidence',async t=>{
  const f=fixture(t);const id=f.runtime.reportTask('task','Report');
  f.state.put('outbox',id,{...f.state.get<Outbox>('outbox',id)!,conversationId:f.c.id,status:'sent'});
  const i=f.runtime.incidents.record(f.c,{source:'delivery',sourceId:'outbox:'+id,kind:'blocked',cause:'delivery_failed'});
  const note=f.runtime.outbox('/chats/rooms/room/messages',{content:'Old failure'},f.c.id);
  f.state.put('outbox',note,{...f.state.get<Outbox>('outbox',note)!,incidentIds:[i.id]});
  const uncertain=f.runtime.outbox('/chats/rooms/room/messages',{content:'Unknown notice outcome'},f.c.id);
  f.state.put('outbox',uncertain,{...f.state.get<Outbox>('outbox',uncertain)!,incidentIds:[i.id],status:'uncertain'});
  f.state.put('incidents',i.id,{...i,reviewedAt:1,notificationIds:[note,uncertain]});
  f.runtime.captureIncidents();assert.equal(f.state.get<Outbox>('outbox',note)!.status,'superseded');
  assert.equal(f.state.get<Outbox>('outbox',uncertain)!.status,'uncertain');
  assert.equal(f.runtime.incidents.context(f.c).pending[0].resolvedAt!==undefined,true);
});
test('blocked follow-up discloses accepted task reopening; orphan pane identity is retained',async t=>{
  const f=fixture(t);f.w.taskId='task';f.state.put('workers',f.w.id,f.w);
  f.runtime.api=async(_path,method)=>{
    if(method==='POST'){f.state.put('workers',f.w.id,{...f.state.get<Worker>('workers',f.w.id)!,recoveryHold:true});return {data:{}};}
    return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'COMPLETED',projectId:null}};
  };
  const result=await f.runtime.control('send',{jobId:f.job.id,workerId:f.w.id,text:'Authorized next stage'}) as {status:string;priorAcceptedTaskTransition:{status:string}};
  assert.equal(result.status,'recovery_blocked');assert.equal(result.priorAcceptedTaskTransition.status,'RUNNING');assert.equal(f.state.all('deliveries').length,0);
  const g=fixture(t);g.w.paneId=undefined;g.state.put('workers',g.w.id,g.w);g.state.put('meta','workspace','workspace');
  g.runtime.herdr.call=async()=>{g.state.put('workers',g.w.id,{...g.w,generation:2});return {root_pane:{pane_id:'unadopted-pane'}};};
  await assert.rejects(g.runtime.launchWorkerSession(g.w,true),/identity or generation/);
  assert.equal(g.state.all<{paneId:string}>('orphanWorkerPanes')[0].paneId,'unadopted-pane');
});
test('report preflight refuses remote ownership drift before any POST',async t=>{
  const f=fixture(t);let posts=0;
  f.runtime.assertAssigned=async()=>({status:'READY'});
  const result=await f.runtime.control('task-report',{jobId:f.job.id,status:'RUNNING',text:'Update'}) as {notificationId:string};
  globalThis.fetch=async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json({data:{assigneeId:'coworker',ownerId:'another-owner',organizationId:'org',status:'READY'}});};
  await f.runtime.flushOutbox();assert.equal(posts,0);
  assert.equal(f.state.get<Outbox>('outbox',result.notificationId)!.status,'failed');
  assert.match(f.state.get<Outbox>('outbox',result.notificationId)!.blockedReason!,/unverified owner\/organization scope/);
});
