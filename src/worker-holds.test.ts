import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createServer} from 'node:http';import {once} from 'node:events';
import test,{type TestContext} from 'node:test';
import {Runtime} from './runtime.ts';import {State,type Worker,type Delivery} from './state.ts';
import type {WorkerHold} from './worker-holds.ts';
async function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'hold-decisions-'));writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://localhost:1',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));let status='working';let prompts=0;
  const dialog='Action: npm test\nDo you want to proceed?\n❯ 1. Yes';
  const runtime=new Runtime(state,{call:async(args)=>{if(args[1]==='read')return {text:dialog};throw new Error('no approval keys');},agents:async()=>[{pane_id:'pane',name:'worker',cwd:dir,agent_status:status}],prompt:async()=>{prompts++;}}, {dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://api.invalid',coworkerId:'coworker'});
  const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'worker',conversationId:c.id,repo:dir,worktree:dir,branch:'feature',prompt:'work',paneId:'pane',state:'working',generation:1,createdAt:0,observedAt:0};state.put('workers',w.id,w);
  const queued=runtime.queueInstruction(w,'Existing authorized instruction');
  status='blocked';await runtime.monitor();
  const held=state.get<Worker>('workers',w.id)!;
  const job=runtime.createResponse(c.owner,c.id,'Inspect exact dialog and record my decision');runtime.nextJob();
  const evidence={holdId:held.holdId!,generation:1,paneId:'pane',actionDigest:'a'.repeat(64),actionText:'npm test',dialogFingerprint:createHash('sha256').update(dialog).digest('hex'),evidenceReference:'private-inspection-reference'};
  const call=(action:string,e:unknown=evidence)=>runtime.control(action,{jobId:job.id,workerId:w.id,evidence:e});
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,state,runtime,c,w,job,queued,evidence,call,prompts:()=>prompts,setStatus:async(s:string)=>{status=s;await runtime.monitor();}};
}
test('known owner-attested dialog resolves after closure, not merely idle/working; receipt survives restart',async t=>{
  const f=await fixture(t);await f.call('record-worker-hold');
  await f.setStatus('working');assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
  await f.setStatus('idle');await f.runtime.deliver();assert.equal(f.prompts(),0);
  const decision={...f.evidence,decision:'approved',decisionReference:'human-decision-reference'};
  const result=await f.call('reconcile-worker-hold',decision);
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,false);
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{const runtime=new Runtime(reopened,f.runtime.herdr,f.runtime.config);assert.deepEqual(await runtime.control('reconcile-worker-hold',{jobId:f.job.id,workerId:f.w.id,evidence:decision}),result);}finally{reopened.close();}
  await f.runtime.deliver();assert.equal(f.prompts(),1);
});
test('control reconciliation returns the same decision receipt after generation drift',async t=>{
  const f=await fixture(t);await f.call('record-worker-hold');await f.setStatus('idle');
  const decision={...f.evidence,decision:'approved',decisionReference:'human-decision-reference'};
  const result=await f.call('reconcile-worker-hold',decision);
  const drifted={...f.state.get<Worker>('workers',f.w.id)!,generation:2};
  f.state.put('workers',f.w.id,drifted);
  assert.deepEqual(await f.call('reconcile-worker-hold',decision),result);
  await assert.rejects(f.call('reconcile-worker-hold',{...decision,decisionReference:'different'}),/conflicts with prior decision/);
});
test('Runtime.control approves only the exact one-time selected provider option',async t=>{
  const f=await fixture(t);
  const currentWorker=f.state.get<Worker>("workers",f.w.id)!;currentWorker.taskId='task';f.state.put('workers',currentWorker.id,currentWorker);const hold=f.state.get<WorkerHold>('workerHolds',currentWorker.holdId!)!;hold.taskId='task';f.state.put('workerHolds',hold.id,hold);
  f.runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'RUNNING'}});
  await f.call('record-worker-hold');
  f.runtime.herdr.call=async(args)=>args[1]==='read'?{text:'Action: npm test\nDo you want to proceed?\n❯ 1. Yes'}:{};
  const routine={...f.evidence,routine:true,category:'tests',key:'enter',actionText:'npm test',authorizationReference:'owner request'};
  const accepted=await f.runtime.control('worker-approve-routine',{jobId:f.job.id,workerId:f.w.id,evidence:routine}) as {status:string};
  assert.equal(accepted.status,'accepted');
  const g=await fixture(t);const currentG=g.state.get<Worker>("workers",g.w.id)!;currentG.taskId='task';g.state.put('workers',currentG.id,currentG);const gh=g.state.get<WorkerHold>('workerHolds',currentG.holdId!)!;gh.taskId='task';g.state.put('workerHolds',gh.id,gh);
  g.runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'RUNNING'}});await g.call('record-worker-hold');
  g.runtime.herdr.call=async(args)=>args[1]==='read'?{text:"Action: npm test\nDo you want to proceed?\n❯ 1. Yes, allow all edits during this session"}:{};
  const gEvidence={...routine,holdId:currentG.holdId,dialogFingerprint:createHash('sha256').update('Action: npm test\nDo you want to proceed?\n❯ 1. Yes, allow all edits during this session').digest('hex')};
  await assert.rejects(g.runtime.control('worker-approve-routine',{jobId:g.job.id,workerId:g.w.id,evidence:gEvidence}),/format or selected option/);
  g.runtime.herdr.call=async(args)=>args[1]==='read'?{text:'Action: npm test\noutput > yes, proceeding\nAction: rm -rf ~/workspaces\nDo you want to proceed?\n❯ 1. No'}:{};
  const stale={...gEvidence,dialogFingerprint:createHash('sha256').update('Action: npm test\noutput > yes, proceeding\nAction: rm -rf ~/workspaces\nDo you want to proceed?\n❯ 1. No').digest('hex')};
  await assert.rejects(g.runtime.control('worker-approve-routine',{jobId:g.job.id,workerId:g.w.id,evidence:stale}),/format or selected option/);
});
test('Runtime.control binds Claude box action and rejects stale recognized prefixes',async t=>{
  const f=await fixture(t);const current=f.state.get<Worker>("workers",f.w.id)!;current.taskId='task';f.state.put('workers',current.id,current);const hold=f.state.get<WorkerHold>('workerHolds',current.holdId!)!;hold.taskId='task';f.state.put('workerHolds',hold.id,hold);
  f.runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'RUNNING'}});
  const box='│ Bash command │\n│ git push --force origin main │\nDo you want to proceed?\n❯ 1. Yes';
  f.runtime.herdr.call=async(args)=>args[1]==='read'?{text:'$ npm test\n'+box}:{};
  await assert.rejects(f.call('record-worker-hold',{...f.evidence,actionText:'npm test',dialogFingerprint:createHash('sha256').update('$ npm test\n'+box).digest('hex')}),/does not match/);
  const g=await fixture(t);const currentG=g.state.get<Worker>("workers",g.w.id)!;currentG.taskId='task';g.state.put('workers',currentG.id,currentG);const gh=g.state.get<WorkerHold>('workerHolds',currentG.holdId!)!;gh.taskId='task';g.state.put('workerHolds',gh.id,gh);g.runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'RUNNING'}});g.runtime.herdr.call=async(args)=>args[1]==='read'?{text:box}:{};
  const recordEvidence={...g.evidence,actionText:'git push --force origin main',dialogFingerprint:createHash('sha256').update(box).digest('hex')};
  await g.call('record-worker-hold',recordEvidence);
  const routine={...recordEvidence,routine:true,category:'tests',key:'enter',authorizationReference:'owner request'};
  const result=await g.runtime.control('worker-approve-routine',{jobId:g.job.id,workerId:g.w.id,evidence:routine}) as {status:string};assert.equal(result.status,'accepted');
});
test('denial/cancellation retires exact queued instructions and stops without replaying the denied action',async t=>{
  for(const decision of ['denied','cancelled']){
    const f=await fixture(t);await f.call('record-worker-hold');await f.setStatus('done');
    const input={...f.evidence,decision,decisionReference:'human-decision'};
    await assert.rejects(f.call('reconcile-worker-hold',input),/retirement list/);
    await f.call('reconcile-worker-hold',{...input,retireDeliveryIds:[f.queued.id]});await f.runtime.deliver();
    assert.equal(f.prompts(),0);assert.equal(f.state.get<Worker>('workers',f.w.id)!.state,'stopped');
    assert.equal(f.state.get<Delivery>('deliveries',f.queued.id)!.status,'superseded');
    assert.equal(f.state.get<WorkerHold>('workerHolds',f.evidence.holdId)!.decision,decision);
  }
});
test('unknown provenance, legacy holds, changed action and uncertain sends fail closed',async t=>{
  const f=await fixture(t);await f.setStatus('idle');
  const decision={...f.evidence,decision:'approved',decisionReference:'human-decision'};
  const closed:any=await f.call('reconcile-worker-hold',{...decision,evidenceReference:'private-closed-dialog'});
  assert.equal(closed.decision,'approved');
  const g=await fixture(t);
  await g.call('record-worker-hold');await g.setStatus('idle');
  await assert.rejects(g.call('reconcile-worker-hold',{...g.evidence,actionDigest:'b'.repeat(64),decision:'approved',decisionReference:'human-decision'}),/Known exact action/);
  g.state.put('deliveries',g.queued.id,{...g.queued,status:'uncertain'});
  await assert.rejects(g.call('reconcile-worker-hold',{...g.evidence,decision:'approved',decisionReference:'human-decision'}),/Unresolved instruction/);
  g.state.put('workers',g.w.id,{...g.state.get<Worker>('workers',g.w.id)!,holdId:undefined});
  await assert.rejects(g.call('reconcile-worker-hold',{...g.evidence,decision:'approved',decisionReference:'human-decision'}),/provenance unknown/);
  assert.equal(g.state.get<Worker>('workers',g.w.id)!.recoveryHold,true);
});
test('exact identity/scope and chat authority required; worker tokens cannot reconcile',async t=>{
  const f=await fixture(t);await f.call('record-worker-hold');await f.setStatus('idle');
  const decision={...f.evidence,decision:'approved',decisionReference:'human-decision'};
  for(const override of [{generation:2},{paneId:'another-pane'},{holdId:'another-hold'}])await assert.rejects(f.call('reconcile-worker-hold',{...decision,...override}),/identity\/scope/);
  const config=f.runtime.scopedConfig({kind:'worker',id:f.w.id,generation:1});const token=JSON.parse(readFileSync(config,'utf8')).token;
  assert.equal(f.runtime.authorizeControl(token,'reconcile-worker-hold',{jobId:f.job.id,workerId:f.w.id,evidence:decision}),false);
  f.state.put('jobs',f.job.id,{...f.job,status:'in_progress',kind:'worker'});await assert.rejects(f.call('reconcile-worker-hold',decision),/active owner chat/);
  f.state.put('jobs',f.job.id,{...f.job,status:'in_progress'});
  f.state.put('conversations',f.c.id,{...f.c,metadata:{sokosumi_organization_id:'other'}});
  await assert.rejects(f.call('reconcile-worker-hold',decision),/scope changed/);
});
test('ownership change across task lookup prevents resolution; no task transitions are sent',async t=>{
  const f=await fixture(t);const w=f.state.get<Worker>('workers',f.w.id)!;w.taskId='task';f.state.put('workers',w.id,w);
  const hold=f.state.get<WorkerHold>('workerHolds',f.evidence.holdId)!;hold.taskId='task';f.state.put('workerHolds',hold.id,hold);
  f.runtime.api=async(_path,method)=>{assert.equal(method,'GET');return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}};};
  await f.call('record-worker-hold');await f.setStatus('idle');
  f.runtime.api=async()=>{f.state.put('workers',w.id,{...f.state.get<Worker>('workers',w.id)!,generation:2});return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}};};
  await assert.rejects(f.call('reconcile-worker-hold',{...f.evidence,decision:'approved',decisionReference:'decision'}),/identity\/scope/);
  assert.equal(f.state.get<Worker>('workers',w.id)!.recoveryHold,true);
});
test('CLI evidence file maps to scoped hold control operations without a shell or approval keys',async t=>{
  const f=await fixture(t);const requests:{url:string|undefined;body:Record<string,unknown>}[]=[];
  const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;requests.push({url:req.url,body:JSON.parse(text)});res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const addr=server.address();assert.ok(addr && typeof addr==='object');
  const config=join(f.dir,'cli.json'),file=join(f.dir,'evidence.json');writeFileSync(config,JSON.stringify({url:`http://127.0.0.1:${addr.port}`,token:'synthetic'}));writeFileSync(file,JSON.stringify(f.evidence));
  for(const command of ['record-worker-hold','reconcile-worker-hold'])await promisify(execFile)(process.execPath,[resolve('src/cli.ts'),command,f.w.id,'--file',file],{env:{...process.env,CODEPAT_CONFIG:config,CODEPAT_JOB_ID:f.job.id}});
  assert.deepEqual(requests.map(r=>r.url),['/control/record-worker-hold','/control/reconcile-worker-hold']);assert.deepEqual(requests[0].body.evidence,f.evidence);
});
test('a dialog reappearing during ownership verification cannot be reconciled',async t=>{
  const f=await fixture(t);const w=f.state.get<Worker>('workers',f.w.id)!;w.taskId='task';f.state.put('workers',w.id,w);
  const hold=f.state.get<WorkerHold>('workerHolds',f.evidence.holdId)!;hold.taskId='task';f.state.put('workerHolds',hold.id,hold);
  f.runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}});
  await f.call('record-worker-hold');await f.setStatus('idle');
  f.runtime.api=async()=>{await f.setStatus('blocked');return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}};};
  await assert.rejects(f.call('reconcile-worker-hold',{...f.evidence,decision:'approved',decisionReference:'decision'}),/dialog changed/);
  assert.equal(f.state.get<Worker>('workers',w.id)!.recoveryHold,true);
});
test('uncertain conversation delivery blocks hold resolution without changing its receipt',async t=>{
  const f=await fixture(t);await f.call('record-worker-hold');await f.setStatus('idle');
  const id=f.runtime.outbox('/chats/rooms/room/messages',{content:'Synthetic'},f.c.id);
  const delivery=f.state.get<Record<string,unknown>>('outbox',id)!;f.state.put('outbox',id,{...delivery,status:'uncertain'});
  await assert.rejects(f.call('reconcile-worker-hold',{...f.evidence,decision:'approved',decisionReference:'decision'}),/Unresolved conversation/);
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
  assert.equal(f.state.get<{status:string}>('outbox',id)!.status,'uncertain');
});
