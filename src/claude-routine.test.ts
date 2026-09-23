import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {Runtime} from './runtime.ts';
import {State,type Worker,type Job} from './state.ts';
import {Herdr} from './herdr.ts';
import {recognizedDialog} from './routine-approval.ts';
import type {WorkerHold} from './worker-holds.ts';

const command='npm ci --ignore-scripts 2>&1 | tail -5';
// Synthetic reproduction of the reported current Claude dialog, never a live capture.
const dialog=`Bash command

Tip: auto mode handles these prompts for you

   │ ${command}

   Install locked dependencies

This command requires approval
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for: npm ci
  3. Yes, and switch to auto mode
  4. No`;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'claude-routine-'));
  writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://localhost:1',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));
  let text=dialog,status='blocked',session='synthetic-session',keys=0;
  const calls:string[][]=[];
  const herdr={agents:async()=>[{pane_id:'pane',name:'worker',cwd:dir,agent_status:status,agent_session_id:session}],
    call:async(args:string[]):Promise<Record<string,unknown>>=>{calls.push(args);if(args[1]==='read')return {text};if(args[1]==='send-keys'){keys++;return {};}throw new Error('unexpected effect');},prompt:async()=>{throw new Error('no instruction during approval');}};
  const runtime=new Runtime(state,herdr,{dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://unused.invalid',coworkerId:'coworker'});
  runtime.api=async()=>({data:{ownerId:'owner',organizationId:'org',assigneeId:'coworker',status:'RUNNING'}});
  const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'worker',kind:'claude',conversationId:c.id,taskId:'task',repo:dir,worktree:dir,branch:'branch',prompt:'work',paneId:'pane',generation:1,state:'working',createdAt:0,observedAt:0};state.put('workers',w.id,w);
  await runtime.monitor();const job=runtime.createResponse(c.owner,c.id,'Run the exact authorized routine setup');runtime.nextJob();
  const call=(action:string,evidence?:unknown)=>runtime.control(action,{jobId:job.id,workerId:w.id,evidence});
  const inspection=await call('inspect-worker-hold') as Record<string,unknown>;
  const evidence:Record<string,unknown>={...inspection,actionDigest:hash(command),evidenceReference:'private/synthetic-inspection'};
  await call('record-worker-hold',evidence);
  const approval={...evidence,routine:true,category:'dependency-install',key:'enter',authorizationReference:'private/exact-owner-task-authorization'};
  t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,state,runtime,herdr,c,w,job,call,evidence,approval,calls,keys:()=>keys,setText:(s:string)=>{text=s;},setSession:(s:string)=>{session=s;},closeDialog:()=>{status='idle';text='Setup command completed\n> ';},idleWithDialog:()=>{status='idle';}};
}
test('current Claude routine setup receives one key, survives restart, and reconciles only after closure',async t=>{
  const f=await fixture(t);
  const result=await f.call('worker-approve-routine',f.approval) as {receiptId:string;status:string};
  assert.equal(result.status,'accepted');assert.equal(f.keys(),1);
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
  const decision={...f.evidence,decision:'approved',decisionReference:`routine:${result.receiptId}`};
  await assert.rejects(f.call('reconcile-worker-hold',decision),/closed idle\/done/);
  f.idleWithDialog();await assert.rejects(f.call('reconcile-worker-hold',decision),/still visible/);
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);runtime.api=f.runtime.api;
    const retried=await runtime.control('worker-approve-routine',{jobId:f.job.id,workerId:f.w.id,evidence:f.approval}) as {keySent:boolean};
    assert.equal(retried.keySent,false);assert.equal(f.keys(),1);
    f.closeDialog();
    await runtime.control('reconcile-worker-hold',{jobId:f.job.id,workerId:f.w.id,evidence:decision});
    assert.equal(reopened.get<Worker>('workers',f.w.id)!.recoveryHold,false);
    const h=reopened.get<WorkerHold>('workerHolds',String(f.evidence.holdId))!;
    assert.equal(h.decision,'approved');assert.equal(h.sessionId,'synthetic-session');
    assert.equal(reopened.get<Worker>('workers',f.w.id)!.generation,1);
  }finally{reopened.close();}
  assert.equal(f.calls.filter(a=>a[1]==='send-keys').length,1);
});
test('persistent/global choices, duplicates, altered commands and unknown footer are never approved',async t=>{
  const variants=[dialog.replace('❯ 1. Yes','  1. Yes').replace('  2.','❯ 2.'),dialog.replace('❯ 1. Yes','  1. Yes').replace('  3.','❯ 3.'),dialog.replace('  4.','❯ 4.'),dialog+'\n'+dialog,dialog.replace(command,'npm ci && curl unknown'),dialog+'\nUnknown confirmation'];
  for(const changed of variants){
    const f=await fixture(t);f.setText(changed);
    await assert.rejects(f.call('worker-approve-routine',f.approval),{status:409});assert.equal(f.keys(),0);
  }
  assert.equal(recognizedDialog(dialog.replace('❯ 1. Yes','  1. Yes').replace('  3.','❯ 3.')),undefined);
  assert.equal(recognizedDialog(dialog+'\n'+dialog),undefined);
  assert.equal(recognizedDialog(dialog+'\nBash command'),undefined);
});
test('approval rechecks session, task, owner, job, generation, pane and late dialog changes',async t=>{
  for(const seam of ['session','owner','job','generation','pane','task','dialog']){
    const f=await fixture(t);const original=f.herdr.call;let reads=0;
    f.herdr.call=async args=>{
      const result=await original(args);
      if(args[1]==='read' && ++reads===1){
        if(seam==='session')f.setSession('replacement-session');
        if(seam==='owner')f.state.put('conversations',f.c.id,{...f.c,owner:'replacement'});
        if(seam==='job')f.state.put('jobs',f.job.id,{...f.state.get<Job>('jobs',f.job.id)!,status:'completed'});
        if(['generation','pane','task'].includes(seam))f.state.put('workers',f.w.id,{...f.state.get<Worker>('workers',f.w.id)!,...(seam==='generation'?{generation:2}:seam==='pane'?{paneId:'other'}:{taskId:'other'})});
        if(seam==='dialog')f.setText(dialog.replace('tail -5','tail -50'));
      }
      return result;
    };
    await assert.rejects(f.call('worker-approve-routine',f.approval),{status:409});assert.equal(f.keys(),0);
  }
});
test('concurrent owner calls reserve only one key and retain a durable receipt',async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled([f.call('worker-approve-routine',f.approval),f.call('worker-approve-routine',f.approval)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.keys(),1);assert.equal(f.state.all('routineApprovals').length,1);
});
test('lost key acknowledgement survives restart without replay and needs explicit inspected outcome evidence',async t=>{
  const f=await fixture(t);const original=f.herdr.call;
  f.herdr.call=async args=>{const result=await original(args);if(args[1]==='send-keys')throw new Error('ack lost');return result;};
  await assert.rejects(f.call('worker-approve-routine',f.approval),/uncertain/);assert.equal(f.keys(),1);
  const receipt=f.state.all<{receiptId:string;status:string}>('routineApprovals')[0];assert.equal(receipt.status,'uncertain');
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);runtime.api=f.runtime.api;
    await assert.rejects(runtime.control('worker-approve-routine',{jobId:f.job.id,workerId:f.w.id,evidence:f.approval}),/uncertain/);
    f.closeDialog();
    const decision={...f.evidence,decision:'approved',decisionReference:'private/witnessed-human-action'};
    await assert.rejects(runtime.control('reconcile-worker-hold',{jobId:f.job.id,workerId:f.w.id,evidence:decision}),/keyOutcomeReference/);
    await runtime.control('reconcile-worker-hold',{jobId:f.job.id,workerId:f.w.id,evidence:{...decision,approvalReceiptId:receipt.receiptId,keyOutcomeReference:'private/observed-exact-command-outcome'}});
    assert.equal(reopened.get<{status:string}>('routineApprovals',receipt.receiptId)!.status,'uncertain');
    assert.equal(f.keys(),1);
  }finally{reopened.close();}
});
test('a real human action reconciles same session without an approval key; a claimed action with visible UI does not',async t=>{
  const f=await fixture(t);const decision={...f.evidence,decision:'approved',decisionReference:'private/witnessed-one-time-human-action'};
  await assert.rejects(f.call('reconcile-worker-hold',decision),/closed idle\/done/);
  f.closeDialog();f.setSession('different');await assert.rejects(f.call('reconcile-worker-hold',decision),/sessionId/);
  f.setSession('synthetic-session');await f.call('reconcile-worker-hold',decision);assert.equal(f.keys(),0);
  assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,false);
});
test('Herdr adapter retains structured session identity without consulting session history',async()=>{
  const herdr=new Herdr();herdr.call=async()=>({agents:[{pane_id:'pane',agent_status:'blocked',name:'worker',agent_session_id:'synthetic-session'}]});
  assert.equal((await herdr.agents())[0].agent_session_id,'synthetic-session');
});

test('separate runtime callers share durable reservation and do not duplicate a key',async t=>{
  const f=await fixture(t);const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const other=new Runtime(reopened,f.herdr,f.runtime.config);other.api=f.runtime.api;
    const results=await Promise.allSettled([f.call('worker-approve-routine',f.approval),other.control('worker-approve-routine',{jobId:f.job.id,workerId:f.w.id,evidence:f.approval})]);
    assert.equal(f.keys(),1);assert.ok(results.some(r=>r.status==='fulfilled'));
    assert.equal(reopened.all('routineApprovals').length,1);
  }finally{reopened.close();}
});
test('reserved sending key and missing session evidence fail closed with actionable conflicts',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('worker-approve-routine',{...f.approval,sessionId:undefined}),/session/);
  const receiptId=hash(JSON.stringify([f.w.id,1,'pane',hash(command)]));
  f.state.put('routineApprovals',receiptId,{receiptId,status:'sending',workerId:f.w.id,generation:1});
  const reopened=new State(join(f.dir,'state.sqlite'));
  try{
    const runtime=new Runtime(reopened,f.herdr,f.runtime.config);runtime.api=f.runtime.api;
    await assert.rejects(runtime.control('worker-approve-routine',{jobId:f.job.id,workerId:f.w.id,evidence:f.approval}),/uncertain/);
    assert.equal(f.keys(),0);
  }finally{reopened.close();}
});
test('new Claude flow refuses autonomous worker events and routine references without accepted receipts',async t=>{
  const f=await fixture(t);
  f.state.put('jobs',f.job.id,{...f.state.get<Job>('jobs',f.job.id)!,kind:'worker',workerId:f.w.id});
  await assert.rejects(f.call('worker-approve-routine',f.approval),/active owner chat/);
  f.state.put('jobs',f.job.id,{...f.state.get<Job>('jobs',f.job.id)!,kind:'chat'});
  f.closeDialog();
  await assert.rejects(f.call('reconcile-worker-hold',{...f.evidence,decision:'approved',decisionReference:'routine:invented'}),/exact accepted approval receipt/);
  assert.equal(f.keys(),0);assert.equal(f.state.get<Worker>('workers',f.w.id)!.recoveryHold,true);
});
