import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {Runtime} from './runtime.ts';
import {State,type Worker,type Delivery} from './state.ts';
import {type Incident} from './incidents.ts';
function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'worker-guard-'));
  writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://localhost:1',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));
  const prompts:string[]=[];const calls:string[][]=[];
  const herdr={call:async(args:string[])=>{calls.push(args);return {root_pane:{pane_id:'new-pane'}};},agents:async()=>[{pane_id:'pane',name:'example',cwd:dir,agent_status:'idle'}],prompt:async(_target:string,text:string)=>{prompts.push(text);}};
  const runtime=new Runtime(state,herdr,{dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://localhost:1'});
  const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'example',conversationId:c.id,repo:dir,worktree:dir,branch:'feature',prompt:'work',paneId:'pane',state:'idle',generation:1,createdAt:0,observedAt:0};
  state.put('workers',w.id,w);state.put('meta','workspace','workspace');
  const hold=()=>state.put('workers',w.id,{...state.get<Worker>('workers',w.id)!,recoveryHold:true});
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,state,runtime,herdr,w,c,prompts,calls,hold};
}
test('send, resume and direct wake respect holds before any preparation or launch',async t=>{
  const f=fixture(t);f.w.state='completed';f.w.result='Prior stage';f.state.put('workers',f.w.id,f.w);f.hold();const job=f.runtime.createResponse(f.c.owner,f.c.id,'Continue');f.runtime.nextJob();
  f.runtime.prepareFollowup=async()=>{throw new Error('must not prepare');};
  for(const action of ['send','resume']){
    const result=await f.runtime.control(action,{jobId:job.id,workerId:f.w.id,text:'Continue'}) as {status:string;approvalHold:boolean};
    assert.equal(result.status,'recovery_blocked');assert.equal(result.approvalHold,true);
  }
  await assert.rejects(f.runtime.wakeWorker(f.w),/hold retained/);
  assert.equal(f.state.all('deliveries').length,0);assert.equal(f.calls.length,0);
});
test('held queued instructions survive SQLite reopen without replay or generation change',async t=>{
  const f=fixture(t);const d=f.runtime.queueInstruction(f.w,'Keep this instruction');f.hold();
  await f.runtime.deliver();
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);await runtime.deliver();
    const kept=reopened.get<Delivery>('deliveries',d.id)!;
    assert.equal(kept.status,'queued');assert.equal(kept.text,d.text);assert.match(kept.blockedReason!,/hold retained/);
    assert.equal(reopened.get<Worker>('workers',f.w.id)!.generation,1);
    assert.equal(f.prompts.length,0);
  }finally{reopened.close();}
});
test('uncertain sibling blocks send and queued dispatch; different worker remains independent',async t=>{
  const f=fixture(t);const queued=f.runtime.queueInstruction(f.w,'Pending');
  f.state.put('deliveries','uncertain',{...queued,id:'uncertain',status:'uncertain'});
  const j=f.runtime.createResponse(f.c.owner,f.c.id,'Continue');f.runtime.nextJob();
  const result=await f.runtime.control('send',{jobId:j.id,workerId:f.w.id,text:'More'}) as {uncertainDeliveryIds:string[]};
  assert.deepEqual(result.uncertainDeliveryIds,['uncertain']);
  await f.runtime.deliver();assert.equal(f.prompts.length,0);
  assert.equal(f.state.get<Delivery>('deliveries','uncertain')!.status,'uncertain');
  assert.match(f.state.get<Delivery>('deliveries',queued.id)!.blockedReason!,/unresolved/);
  const other={...f.w,id:'other',conversationId:'other-conversation'};f.state.put('workers',other.id,other);
  f.runtime.queueInstruction(other,'Other owned work');await f.runtime.deliver();assert.equal(f.prompts.length,1);
});
test('dispatch rechecks holds after task read and after pane read without claiming uncertainty',async t=>{
  for(const seam of ['task','pane']){
    const f=fixture(t);f.w.taskId='task';f.state.put('workers',f.w.id,f.w);
    const d=f.runtime.queueInstruction(f.w,'Continue');
    f.runtime.assertAssigned=async()=>{if(seam==='task')f.hold();return {};};
    const agents=f.herdr.agents;f.herdr.agents=async()=>{if(seam==='pane')f.hold();return agents();};
    await f.runtime.deliver();assert.equal(f.prompts.length,0);
    assert.equal(f.state.get<Delivery>('deliveries',d.id)!.status,'queued');
    assert.equal(f.state.get<Worker>('workers',f.w.id)!.generation,1);
  }
});
test('send rechecks after prepare; wake retains created pane and hold but does not start an agent',async t=>{
  const f=fixture(t);const j=f.runtime.createResponse(f.c.owner,f.c.id,'Continue');f.runtime.nextJob();
  f.runtime.prepareFollowup=async()=>{f.hold();};
  const result=await f.runtime.control('send',{jobId:j.id,workerId:f.w.id,text:'Continue'}) as {status:string};
  assert.equal(result.status,'recovery_blocked');assert.equal(f.state.all('deliveries').length,0);
  const g=fixture(t);g.w.paneId=undefined;g.w.archivedAt=1;g.state.put('workers',g.w.id,g.w);
  g.herdr.agents=async()=>[];
  const call=g.herdr.call;g.herdr.call=async args=>{const result=await call(args);g.hold();return result;};
  await assert.rejects(g.runtime.wakeWorker(g.w),/hold retained/);
  assert.equal(g.calls.length,1);assert.equal(g.calls[0][0],'tab');
  assert.equal(g.state.get<Worker>('workers',g.w.id)!.paneId,'new-pane');
  assert.equal(g.state.get<Worker>('workers',g.w.id)!.recoveryHold,true);
});
test('ordinary busy steering works; recovery notice follows prompt acknowledgment exactly once',async t=>{
  const f=fixture(t);f.w.state='working';f.state.put('workers',f.w.id,f.w);
  f.herdr.agents=async()=>[{pane_id:'pane',name:'example',cwd:f.dir,agent_status:'working'}];
  const d=f.runtime.queueInstruction(f.w,'Authorized steering');f.state.put('deliveries',d.id,{...d,recoveryNotice:true});
  f.herdr.prompt=async(_target,text)=>{
    assert.equal(f.state.all<Incident>('incidents').filter(i=>i.kind==='recovered').length,0);f.prompts.push(text);
  };
  await f.runtime.deliver();await f.runtime.deliver();
  assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/Reconcile prior actions/);
  assert.equal(f.state.get<Delivery>('deliveries',d.id)!.status,'sent');
  assert.equal(f.state.all<Incident>('incidents').filter(i=>i.kind==='recovered').length,1);
});
test('lost prompt ack remains uncertain and emits no false recovery or second prompt',async t=>{
  const f=fixture(t);const d=f.runtime.queueInstruction(f.w,'Continue');f.state.put('deliveries',d.id,{...d,recoveryNotice:true});
  let attempts=0;f.herdr.prompt=async()=>{attempts++;throw new Error('synthetic lost acknowledgment');};
  await f.runtime.deliver();await f.runtime.deliver();
  assert.equal(attempts,1);assert.equal(f.state.get<Delivery>('deliveries',d.id)!.status,'uncertain');
  assert.equal(f.state.all<Incident>('incidents').filter(i=>i.kind==='recovered').length,0);
});
test('automatic recovery stops at a hold arriving during assignment read without overwriting it',async t=>{
  const f=fixture(t);f.w.state='missing';f.w.taskId='task';f.state.put('workers',f.w.id,f.w);
  f.runtime.assertAssigned=async()=>{f.hold();return {status:'READY'};};
  await f.runtime.recoverWorkers();
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
  assert.equal(f.calls.length,0);assert.equal(f.state.all('deliveries').length,0);
  assert.equal(f.state.all<Incident>('incidents').filter(i=>i.kind==='recovered').length,0);
});
test('hold arriving during agent start is preserved and never produces a recovered notice',async t=>{
  const f=fixture(t);f.w.archivedAt=1;f.w.paneId=undefined;f.state.put('workers',f.w.id,f.w);
  f.herdr.agents=async()=>[];
  f.herdr.call=async args=>{f.calls.push(args);if(args[0]==='agent')f.hold();return {root_pane:{pane_id:'pane'}};};
  await assert.rejects(f.runtime.wakeWorker(f.w),/hold retained/);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1][0],'agent');
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
  assert.equal(f.state.all<Incident>('incidents').filter(i=>i.kind==='recovered').length,0);
});

test('lost archived startup acknowledgement reuses same idle pane across restart and concurrent retries',async t=>{
  const f=fixture(t);f.w.archivedAt=1;f.w.paneId=undefined;f.w.state='stopped';f.state.put('workers',f.w.id,f.w);
  let launched=false,starts=0;
  f.herdr.agents=async()=>launched?[{pane_id:'new-pane',name:f.w.name,cwd:f.dir,agent_status:'idle'}]:[];
  f.herdr.call=async args=>{f.calls.push(args);if(args[0]==='agent'){starts++;launched=true;throw new Error('lost startup ack');}return {root_pane:{pane_id:'new-pane'}};};
  const j=f.runtime.createResponse(f.c.owner,f.c.id,'Resume');f.runtime.nextJob();
  const body={jobId:j.id,workerId:f.w.id,text:'Continue retained work'};
  await assert.rejects(f.runtime.control('resume',body),/lost startup ack/);
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.archivedAt,1);
  assert.equal(f.state.all('deliveries').length,0);
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);
    const outcomes=await Promise.allSettled([runtime.control('resume',body),runtime.control('resume',body)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    const queued=reopened.all<Delivery>('deliveries');assert.equal(queued.length,1);
    assert.deepEqual(await runtime.control('resume',body),queued[0]);
    assert.equal(reopened.get<Worker>('workers',f.w.id)!.generation,1);
    assert.equal(reopened.get<Worker>('workers',f.w.id)!.paneId,'new-pane');
    await runtime.deliver();await runtime.control('resume',body);await runtime.deliver();
    assert.equal(f.prompts.length,1);assert.equal(starts,1);
    assert.equal(f.calls.filter(a=>a[0]==='tab').length,1);
  }finally{reopened.close();}
});

test('archived session ambiguity, busy UI and changed ownership never launch or prompt',async t=>{
  for(const mode of ['missing','pane','name','cwd','busy','duplicate','generation','hold','owner','task','uncertain']){
    const f=fixture(t);f.w.archivedAt=1;f.state.put('workers',f.w.id,f.w);
    f.herdr.agents=async()=>{
      const live={pane_id:'pane',name:'example',cwd:f.dir,agent_status:'idle'};
      if(mode==='missing')return [];
      if(mode==='pane')live.pane_id='different';if(mode==='name')live.name='different';if(mode==='cwd')live.cwd='different';if(mode==='busy')live.agent_status='blocked';
      if(mode==='generation')f.state.put('workers',f.w.id,{...f.w,generation:2});
      if(mode==='hold')f.hold();
      if(mode==='owner')f.state.put('conversations',f.c.id,{...f.c,owner:'different'});
      return mode==='duplicate'?[live,{...live,pane_id:'other'}]:[live];
    };
    if(mode==='task'){f.w.taskId='task';f.state.put('workers',f.w.id,f.w);f.runtime.assertAssigned=async()=>({ownerId:'other',organizationId:'org'});}
    if(mode==='uncertain')f.state.put('deliveries','uncertain',{id:'uncertain',workerId:f.w.id,status:'uncertain'});
    await assert.rejects(f.runtime.wakeWorker(f.w));
    assert.equal(f.calls.length,0);assert.equal(f.prompts.length,0);assert.equal(f.state.get<Worker>('workers',f.w.id)!.archivedAt,1);
  }
});

test('disabled Grok remains inspectable across restart but cannot hire, launch, resume or receive prompts',async t=>{
  const f=fixture(t);f.runtime.config.workerKinds=['codex','claude'];
  f.w.kind='grok';f.w.state='stopped';f.state.put('workers',f.w.id,f.w);
  const before=f.state.get<Worker>('workers',f.w.id)!;
  const job=f.runtime.createResponse(f.c.owner,f.c.id,'Inspect only');
  const context=f.runtime.nextJob()!.context as {workerKinds:string[]};
  assert.deepEqual(context.workerKinds,['codex','claude']);
  let requests=0;f.runtime.api=async()=>{requests++;throw new Error('must not contact task API');};
  await assert.rejects(f.runtime.startWorker(job,'work','new-grok',{kind:'grok'}),/Unsupported worker kind/);
  assert.equal(requests,0);assert.equal(f.state.all('workerKeys').length,0);assert.equal(f.state.all('workers').length,1);
  await assert.rejects(f.runtime.launchWorkerSession(f.w,true),/disabled or unavailable/);
  for(const action of ['send','resume']){
    const result=await f.runtime.control(action,{jobId:job.id,workerId:f.w.id,text:'No replay'}) as {status:string;reason:string};
    assert.equal(result.status,'recovery_blocked');assert.match(result.reason,/disabled or unavailable/);
  }
  assert.deepEqual(f.state.get('workers',f.w.id),before);
  assert.deepEqual(f.runtime.workers(),[before]);assert.equal(f.calls.length,0);
  f.state.put('deliveries','retained',{id:'retained',workerId:f.w.id,text:'Historical queued instruction',status:'queued',createdAt:0});
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);await runtime.deliver();
    assert.equal(reopened.get<Delivery>('deliveries','retained')!.status,'queued');
    assert.deepEqual(reopened.get('workers',f.w.id),before);assert.equal(f.prompts.length,0);
  }finally{reopened.close();}
});
