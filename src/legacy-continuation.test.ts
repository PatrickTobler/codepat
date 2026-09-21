import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {Runtime} from './runtime.ts';import {State,type Worker,type Delivery} from './state.ts';
import {LegacyContinuation} from './legacy-continuation.ts';import {reconcileStartupNotice} from './startup-notice.ts';
function fixture(t:TestContext,kind:'codex'|'claude'='codex'){
  const dir=mkdtempSync(join(tmpdir(),'legacy-continuation-'));const history=join(dir,'history');mkdirSync(history);
  writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://localhost:1',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));const calls:string[][]=[];const prompts:string[]=[];let live=false,status='idle';
  const herdr={call:async(args:string[])=>{calls.push(args);if(args[0]==='tab')return {root_pane:{pane_id:'new-pane'}};if(args[0]==='agent'){live=true;return {};}return {panes:[]};},agents:async()=>live?[{pane_id:state.get<Worker>('workers','worker')!.paneId!,name:'example',cwd:dir,agent_status:status}]:[],prompt:async(_pane:string,text:string)=>{prompts.push(text);}};
  const r=new Runtime(state,herdr,{dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://localhost:1',coworkerId:'coworker'});
  const c=r.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'example',kind,conversationId:c.id,taskId:'task',repo:dir,worktree:dir,branch:'feature',prompt:'Original task',state:'completed',result:'Partial, zero data inspected',recoveryHold:true,generation:1,paneId:'old-pane',createdAt:0,observedAt:0};state.put('workers',w.id,w);state.put('meta','workspace','workspace');
  for(const id of ['old-one','old-two'])state.put('deliveries',id,{id,workerId:w.id,text:'Old unresolved instruction',status:'uncertain',createdAt:0});
  const job=r.createResponse(c.owner,c.id,'Authorize new independent read-only inspection, never replay old actions');r.nextJob();
  r.api=async(_path,method)=>{assert.equal(method,'GET');return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}};};
  const service=new LegacyContinuation(r,{codex:history,claude:history});const sessionId='00000000-0000-4000-8000-000000000001',file=join(history,'session.jsonl');
  writeFileSync(file,JSON.stringify(kind==='claude'?{sessionId,cwd:dir}:{type:'session_meta',payload:{id:sessionId,cwd:dir}})+'\n');
  const evidence={key:'new-readonly-stage',expectedSnapshot:service.plan(job,w.id).expectedSnapshot,readOnly:true,noHistoricalReplay:true,quarantineDeliveryIds:['old-one','old-two'],sessionId,sessionEvidenceReference:file,authorizationReference:'owner-message-reference',instruction:'Verify read-only copy provenance before inspecting any data; no production fallback.'};
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,history,state,r,c,w,job,service,evidence,calls,prompts,herdr,setLive:(value:boolean,s='idle')=>{live=value;status=s;}};
}
test('legacy read-only continuation keeps historical hold/outcomes and exact task/session identity',async t=>{
  for(const kind of ['codex','claude'] as const){
    const f=fixture(t,kind);const before=JSON.stringify(f.state.all('deliveries'));
    const result=await f.service.run(f.job,f.w.id,f.evidence);assert.equal(result.status,'accepted');
    assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/remain UNKNOWN/);assert.match(f.prompts[0],/no production fallback/i);
    assert.equal(JSON.stringify(f.state.all('deliveries')),before);const saved=f.state.get<Worker>('workers',f.w.id)!;
    assert.equal(saved.recoveryHold,true);assert.equal(saved.taskId,f.w.taskId);assert.equal(saved.worktree,f.dir);assert.equal(saved.branch,f.w.branch);assert.equal(saved.generation,2);
    const grant=f.state.get<{priorResult:string;originIdentity:{paneId:string}}>('legacyContinuations',f.w.id)!;assert.equal(grant.priorResult,f.w.result);assert.equal(grant.originIdentity.paneId,'old-pane');
    const launch=f.calls.find(a=>a[0]==='agent')!;assert.ok(launch.includes(f.evidence.sessionId));assert.ok(!launch.includes('--last'));assert.ok(!launch.includes('acceptEdits'));
    assert.ok(launch.includes(kind==='codex'?'read-only':'plan'));
    assert.deepEqual(await f.service.run(f.job,f.w.id,f.evidence),result);assert.equal(f.prompts.length,1);
    const blocked=await f.r.control('send',{jobId:f.job.id,workerId:f.w.id,text:'Unauthorized widening'}) as {status:string};assert.equal(blocked.status,'recovery_blocked');
  }
});
test('lost prompt acknowledgement persists uncertain across reopen, with no blind replay',async t=>{
  const f=fixture(t);let attempts=0;f.herdr.prompt=async()=>{attempts++;throw new Error('synthetic lost acknowledgment');};
  assert.equal((await f.service.run(f.job,f.w.id,f.evidence)).status,'uncertain');
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{const r=new Runtime(reopened,f.herdr,f.r.config);const s=new LegacyContinuation(r,{codex:f.history,claude:f.history});assert.equal((await s.run(f.job,f.w.id,f.evidence)).status,'uncertain');}finally{reopened.close();}
  assert.equal(attempts,1);assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
});
test('live or blocked retained session is never replaced or prompted; restricted startup dialog waits',async t=>{
  const f=fixture(t);f.setLive(true,'blocked');const first=await f.service.run(f.job,f.w.id,f.evidence);assert.equal(first.status,'blocked');assert.equal(f.calls.length,0);assert.equal(f.prompts.length,0);
  f.setLive(false);const call=f.herdr.call;f.herdr.call=async args=>{const result=await call(args);if(args[0]==='agent')f.setLive(true,'blocked');return result;};
  assert.equal((await f.service.run(f.job,f.w.id,f.evidence)).status,'waiting');assert.equal(f.prompts.length,0);
  f.setLive(true,'idle');assert.equal((await f.service.run(f.job,f.w.id,f.evidence)).status,'accepted');assert.equal(f.calls.filter(a=>a[0]==='agent').length,1);
});
test('ownership/identity/delivery races and wrong saved history stop before effects',async t=>{
  for(const change of ['owner','generation','delivery','session']){
    const f=fixture(t);
    if(change==='session')writeFileSync(f.evidence.sessionEvidenceReference,JSON.stringify({type:'session_meta',payload:{id:f.evidence.sessionId,cwd:f.history}}));
    else f.r.api=async()=>{
      if(change==='owner')f.state.put('conversations',f.c.id,{...f.c,owner:'other'});
      if(change==='generation')f.state.put('workers',f.w.id,{...f.w,generation:2});
      if(change==='delivery')f.state.put('deliveries','new',{id:'new',workerId:f.w.id,status:'uncertain',text:'new',createdAt:0});
      return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker'}};
    };
    assert.equal((await f.service.run(f.job,f.w.id,f.evidence)).status,'blocked');assert.equal(f.calls.length,0);assert.equal(f.prompts.length,0);
  }
});
test('uncertain launch never restarts; stale authorization and reporting scope are refused',async t=>{
  const f=fixture(t);const call=f.herdr.call;f.herdr.call=async args=>{if(args[0]==='agent')throw new Error('unknown start outcome');return call(args);};
  assert.equal((await f.service.run(f.job,f.w.id,f.evidence)).status,'uncertain');await f.service.run(f.job,f.w.id,f.evidence);
  assert.equal(f.calls.filter(a=>a[0]==='tab').length,1);
  await assert.rejects(f.service.run(f.job,f.w.id,{...f.evidence,instruction:'different'}),/differs/);
  const token=JSON.parse(readFileSync(f.r.scopedConfig({kind:'worker',id:f.w.id,generation:1}),'utf8')).token;
  for(const action of ['worker-continuation-plan','continue-worker-readonly','reconcile-startup-notice'])assert.equal(f.r.authorizeControl(token,action,{jobId:f.job.id,workerId:f.w.id}),false);
  await assert.rejects(f.service.run({...f.job,kind:'review'},f.w.id,f.evidence),/active owner chat/);
});
async function startupFixture(t:TestContext){
  const f=fixture(t);f.state.db.prepare("DELETE FROM records WHERE kind='deliveries'").run();
  const w={...f.w,generation:0,result:undefined,state:'idle'};f.state.put('workers',w.id,w);f.setLive(true);
  return {...f,e:{expectedSnapshot:f.service.plan(f.job,w.id).expectedSnapshot,notice:'codex_update_available',decision:'skip',noCommandApproved:true,evidenceReference:'witnessed-update-menu-and-skip'}};
}
test('known startup update skip is audited without granting command approval or sending input',async t=>{
  const f=await startupFixture(t);const result=await reconcileStartupNotice(f.r,f.job,f.w.id,f.e);
  assert.equal(result.status,'notice_reconciled');assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,false);assert.equal(f.prompts.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.state.all<{noCommandApproved:boolean}>('startupNoticeReceipts')[0].noCommandApproved,true);
  await reconcileStartupNotice(f.r,f.job,f.w.id,f.e);assert.equal(f.state.all('startupNoticeReceipts').length,1);
});
test('already-running startup case, unknown dialogs, uncertain history and races cannot be released',async t=>{
  for(const change of ['working','unknown','uncertain','dialog','owner']){
    const f=await startupFixture(t);
    if(change==='working')f.state.put('workers',f.w.id,{...f.w,state:'working',generation:1,recoveryHold:false});
    if(change==='unknown')f.e.notice='unknown-command';
    if(change==='uncertain')f.state.put('deliveries','old',{id:'old',workerId:f.w.id,status:'uncertain',text:'unknown'});
    if(change==='dialog')f.setLive(true,'blocked');
    if(change==='owner')f.r.api=async()=>({data:{ownerId:'other',organizationId:'org',assigneeId:'coworker'}});
    await assert.rejects(reconcileStartupNotice(f.r,f.job,f.w.id,f.e));assert.equal(f.prompts.length,0);assert.equal(f.state.all('startupNoticeReceipts').length,0);
  }
});
test('accepted reservation status cannot leak through a changed owner plan',async t=>{
  const f=fixture(t);await f.service.run(f.job,f.w.id,f.evidence);
  f.state.put('conversations',f.c.id,{...f.c,owner:'new-owner'});
  assert.throws(()=>f.service.plan(f.job,f.w.id),/scope changed/);
});
