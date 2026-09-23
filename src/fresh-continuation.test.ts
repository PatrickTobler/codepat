import assert from 'node:assert/strict';
import {once} from 'node:events';
import test,{type TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {State,type Worker,type Delivery} from './state.ts';
import {Runtime} from './runtime.ts';
import {Herdr} from './herdr.ts';
async function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'fresh-worker-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const git=(...a:string[])=>execFileSync('git',['-C',dir,...a],{stdio:'pipe'});
 git('init','-b','retained');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','retained work');
 writeFileSync(join(dir,'.gitignore'),'client.json\nstate.sqlite*\nscopes/\n');git('add','.gitignore');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','ignore fixture state');
 writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://unused.invalid',token:'synthetic'}));
 const state=new State(join(dir,'state.sqlite'));t.after(()=>state.close());let live=false,status='idle',session='fresh-session',taskStatus='RUNNING';
 const calls:string[][]=[],prompts:string[]=[];const herdr=new Herdr();
 herdr.call=async a=>{calls.push(a);if(a[0]==='agent'&&a[1]==='list')return {agents:live?[{pane_id:'new-pane',name:'worker',cwd:dir,agent:'codex',agent_status:status,agent_session:session?{source:'herdr:codex',agent:'codex',kind:'id',value:session}:undefined}]:[]};if(a[0]==='pane'&&a[1]==='process-info')return {process_info:{shell_pid:10,foreground_processes:[{pid:11,name:'codex'}]}};if(a[0]==='pane'&&a[1]==='close'){live=false;return {};}if(a[0]==='tab')return {root_pane:{pane_id:'new-pane'}};if(a[1]==='start'){live=true;return {};}if(a[1]==='list')return {panes:[]};throw new Error('unexpected effect');};
 herdr.prompt=async(_p,text)=>{prompts.push(text);};
 const runtime=new Runtime(state,herdr,{dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://unused.invalid',coworkerId:'coworker'});
 runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:taskStatus,projectId:null}});
 const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
 const w:Worker={id:'worker',name:'worker',kind:'codex',conversationId:c.id,taskId:'task',repo:dir,worktree:dir,branch:'retained',prompt:'original scope',state:'completed',result:'Existing result and PR',archivedAt:1,generation:4,createdAt:0,observedAt:0};state.put('workers',w.id,w);state.put('meta','workspace','workspace');
 const job=runtime.createResponse('owner',c.id,'Continue already authorized task in new session');runtime.nextJob();
 const call=(action:string,evidence?:unknown)=>runtime.control(action,{jobId:job.id,workerId:w.id,evidence});
 const evidence=async()=>({...await call('fresh-worker-plan') as object,key:'fresh-1',newSession:true,noHistoricalReplay:true,instruction:'Inspect existing PR and finish only remaining authorized work',authorizationReference:'private/owner-request',handoffReference:'private/git-pr-results-reconciled'});
 return {dir,state,runtime,herdr,w,c,job,call,evidence,calls,prompts,setLive:(v:boolean)=>{live=v;},setSession:(v:string)=>{session=v;},setStatus:(v:string)=>{status=v;},setTask:(v:string)=>{taskStatus=v;}};
}
test('fresh same-task continuation quarantines old actions and dispatches new work once across restart',async t=>{
 const f=await fixture(t);
 for(const status of ['queued','uncertain'] as const)f.state.put('deliveries',status,{id:status,workerId:f.w.id,text:'NEVER REPLAY '+status,status,createdAt:0});
 const e=await f.evidence();const receipt=await f.call('continue-worker-fresh',e) as {phase:string;deliveryId:string;receiptId:string};assert.equal(receipt.phase,'queued');
 assert.equal(f.prompts.length,0);
 for(const id of ['queued','uncertain']){const d=f.state.get<Delivery>('deliveries',id)!;assert.equal(d.status,'quarantined');assert.equal(d.priorStatus,id);assert.equal(d.text,'NEVER REPLAY '+id);}
 const restarted=new State(join(f.dir,'state.sqlite'));t.after(()=>restarted.close());const rt=new Runtime(restarted,f.herdr,f.runtime.config);rt.api=f.runtime.api;
 assert.equal((await rt.control('continue-worker-fresh',{jobId:f.job.id,workerId:f.w.id,evidence:e}) as {receiptId:string}).receiptId,receipt.receiptId);
 await rt.deliver();await rt.deliver();assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/NEW provider session/);assert.doesNotMatch(f.prompts[0],/NEVER REPLAY/);
 const current=restarted.get<Worker>('workers',f.w.id)!;assert.equal(current.taskId,'task');assert.equal(current.worktree,f.w.worktree);assert.equal(current.branch,'retained');assert.equal(current.generation,6);assert.equal(current.priorResult,f.w.result);assert.equal(current.sessionId,'fresh-session');
 const config=rt.scopedConfig({kind:'worker',id:f.w.id,generation:6});const token=JSON.parse(readFileSync(config,'utf8')).token;assert.equal(rt.authorizeControl(token,'worker-result',{workerId:f.w.id}),true);
 await rt.control('worker-result',{workerId:f.w.id,text:'Verified new work result'});assert.equal(restarted.get<Worker>('workers',f.w.id)!.result,'Verified new work result');
 assert.equal(f.calls.filter(a=>a[0]==='tab').length,1);assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});
test('fresh continuation refuses holds, live sessions, canceled tasks, in-flight instructions and changed Git',async t=>{
 for(const seam of ['hold','live','canceled','sending','git']){
  const f=await fixture(t);const e=await f.evidence();
  if(seam==='hold')f.state.put('workers',f.w.id,{...f.w,recoveryHold:true});
  if(seam==='live')f.setLive(true);
  if(seam==='canceled')f.setTask('CANCELLED');
  if(seam==='sending')f.state.put('deliveries','flight',{id:'flight',workerId:f.w.id,text:'in flight',status:'sending',createdAt:0});
  if(seam==='git')writeFileSync(join(f.dir,'changed.txt'),'new work');
  await assert.rejects(f.call('continue-worker-fresh',e),{status:409});assert.equal(f.calls.filter(a=>['start','create'].includes(a[1])).length,0);assert.equal(f.prompts.length,0);assert.equal(f.state.all('freshContinuations').length,0);
 }
});
test('missing native metadata waits without launches or prompts; real matching metadata completes same reservation',async t=>{
 const f=await fixture(t);f.setSession('');const e=await f.evidence();assert.equal((await f.call('continue-worker-fresh',e) as {phase:string}).phase,'waiting');
 await f.runtime.recoverWorkers();await f.runtime.deliver();assert.equal(f.prompts.length,0);
 f.setSession('fresh-session');assert.equal((await f.call('continue-worker-fresh',e) as {phase:string}).phase,'queued');assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});
test('lost external acknowledgements stay uncertain and concurrent retries cannot duplicate startup',async t=>{
 for(const phase of ['create','start']){
  const f=await fixture(t),e=await f.evidence(),original=f.herdr.call;
  f.herdr.call=async args=>{const value=await original(args);if(args[1]===phase)throw new Error('lost acknowledgement');return value;};
  await assert.rejects(f.call('continue-worker-fresh',e),{status:409});await assert.rejects(f.call('continue-worker-fresh',e),/uncertain/);
  assert.equal(f.calls.filter(a=>a[1]===phase).length,1);await f.runtime.recoverWorkers();assert.equal(f.prompts.length,0);
 }
 const f=await fixture(t),e=await f.evidence();const outcomes=await Promise.allSettled([f.call('continue-worker-fresh',e),f.call('continue-worker-fresh',e)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});
test('fresh queued receipt conflicts after retirement/rearchive rather than returning stale success',async t=>{
 const f=await fixture(t),e=await f.evidence();await f.call('continue-worker-fresh',e);const w=f.state.get<Worker>('workers',f.w.id)!;f.state.put('workers',w.id,{...w,archivedAt:10});
 await assert.rejects(f.call('continue-worker-fresh',e),/changed lifecycle/);assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});

test('explicit fresh-session retirement closes only the inspected idle pane and never guesses continuity',async t=>{
 const f=await fixture(t);f.state.put('workers',f.w.id,{...f.w,paneId:'new-pane'});f.setLive(true);f.setSession('');
 const e={...await f.evidence(),retireIdleSession:true};
 const original=f.herdr.call;f.herdr.call=async args=>{const v=await original(args);if(args[1]==='start')f.setSession('authentic-new-session');return v;};
 const receipt=await f.call('continue-worker-fresh',e) as {phase:string;newSession:boolean};assert.equal(receipt.phase,'queued');assert.equal(receipt.newSession,true);
 assert.equal(f.calls.filter(a=>a[1]==='close').length,1);assert.equal(f.calls.filter(a=>a[1]==='start').length,1);assert.equal(f.calls.some(a=>a.includes('resume')||a.includes('--last')||a.includes('send-keys')),false);
 assert.equal(f.state.get<Worker>('workers',f.w.id)!.taskId,f.w.taskId);assert.equal(f.state.get<Worker>('workers',f.w.id)!.sessionId,'authentic-new-session');
});
test('retained process becoming busy prevents retirement, and lost close acknowledgement never replays',async t=>{
 for(const seam of ['busy','lost']){
  const f=await fixture(t);f.state.put('workers',f.w.id,{...f.w,paneId:'new-pane'});f.setLive(true);const e={...await f.evidence(),retireIdleSession:true};
  if(seam==='busy')f.setStatus('working');else{const original=f.herdr.call;f.herdr.call=async a=>{const v=await original(a);if(a[1]==='close')throw new Error('ack lost');return v;};}
  await assert.rejects(f.call('continue-worker-fresh',e),{status:409});
  if(seam==='lost')await assert.rejects(f.call('continue-worker-fresh',e),/uncertain/);
  assert.equal(f.calls.filter(a=>a[1]==='close').length,seam==='lost'?1:0);assert.equal(f.calls.filter(a=>a[1]==='start').length,0);
 }
});

test('completed-task follow-up dispatches, reports result and confirms one task update, then reuses its bound archive',async t=>{
 const f=await fixture(t);let remoteStatus='COMPLETED';const posts:Array<Record<string,unknown>>=[];
 f.runtime.config.apiKey='synthetic';
 f.runtime.api=async(_path,method='GET',body)=>{
  if(method==='POST'){posts.push(body as Record<string,unknown>);if(typeof (body as Record<string,unknown>).status==='string')remoteStatus=String((body as Record<string,unknown>).status);return {data:{id:'event'}};}
  return {data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:remoteStatus,projectId:null}};
 };
 f.state.put('jobs',f.job.id,{...f.state.get('jobs',f.job.id) as object,taskId:f.w.taskId});
 await f.call('continue-worker-fresh',await f.evidence());await f.runtime.flushOutbox();assert.equal(remoteStatus,'RUNNING');
 await f.runtime.deliver();assert.equal(f.prompts.length,1);
 await f.runtime.control('worker-result',{workerId:f.w.id,text:'Verified completed work'});
 await f.runtime.control('review-work',{jobId:f.job.id,workerId:f.w.id,state:'done',text:'Reviewed result and checks'});
 const body={jobId:f.job.id,status:'COMPLETED',text:'Verified task completion'};
 const receipt=await f.runtime.control('task-report',body) as {notificationId:string;status:string};assert.equal(receipt.status,'pending');
 await f.runtime.flushOutbox();assert.equal(remoteStatus,'COMPLETED');
 const accepted=await f.runtime.control('task-report',body) as {notificationId:string;status:string};assert.equal(accepted.notificationId,receipt.notificationId);assert.equal(accepted.status,'sent');
 await f.runtime.flushOutbox();assert.equal(posts.filter(p=>String(p.comment).startsWith('Verified task completion\n')).length,1);
 // A later archive wake has genuine saved-session binding and needs no legacy provenance invention.
 remoteStatus='RUNNING';const current=f.state.get<Worker>('workers',f.w.id)!;f.state.put('workers',current.id,{...current,archivedAt:10,state:'stopped'});
 await f.runtime.wakeWorker(f.state.get<Worker>('workers',current.id)!);assert.equal(f.state.get<Worker>('workers',current.id)!.sessionId,'fresh-session');assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});
test('separate runtime concurrent callers reserve one fresh operation',async t=>{
 const f=await fixture(t),e=await f.evidence();const second=new State(join(f.dir,'state.sqlite'));t.after(()=>second.close());const r=new Runtime(second,f.herdr,f.runtime.config);r.api=f.runtime.api;
 const outcomes=await Promise.allSettled([f.call('continue-worker-fresh',e),r.control('continue-worker-fresh',{jobId:f.job.id,workerId:f.w.id,evidence:e})]);
 assert.ok(outcomes.some(x=>x.status==='fulfilled'));assert.equal(f.state.all('freshContinuations').length,1);assert.equal(f.calls.filter(a=>a[1]==='start').length,1);
});

test('real scoped CLI/HTTP plan and fresh continuation preserve one operation receipt',async t=>{
 const f=await fixture(t);const {createCodePatServer}=await import('./http.ts');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {fileURLToPath}=await import('node:url');
 const server=createCodePatServer({organizationId:'org',controlToken:'synthetic-master',service:f.runtime,authorizeControl:f.runtime.authorizeControl.bind(f.runtime),control:f.runtime.control.bind(f.runtime)});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const address=server.address();assert.ok(address && typeof address==='object');const scoped=f.runtime.scopedConfig({kind:'job',id:f.job.id,generation:0});const config=join(f.dir,'.git','cli-http.json');writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(scoped,'utf8')),url:`http://127.0.0.1:${address.port}`}));
 const run=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./cli.ts',import.meta.url)),...args],{env:{...process.env,CODEPAT_CONFIG:config,CODEPAT_JOB_ID:f.job.id}})).stdout);
 const plan=await run('fresh-worker-plan',f.w.id),path=join(f.dir,'.git','handoff.json');writeFileSync(path,JSON.stringify({...plan,key:'http-operation',newSession:true,noHistoricalReplay:true,instruction:'Inspect prior PR and complete authorized checks',authorizationReference:'private/owner',handoffReference:'private/reconciled-pr'}));
 const receipt=await run('continue-worker-fresh',f.w.id,'--file',path),again=await run('continue-worker-fresh',f.w.id,'--file',path);assert.equal(receipt.receiptId,again.receiptId);assert.equal(receipt.phase,'queued');assert.equal(f.calls.filter(a=>a[1]==='start').length,1);assert.equal(f.prompts.length,0);
});
