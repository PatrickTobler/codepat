import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ControlConflict} from './control-error.ts';
import {paneFrom} from './herdr.ts';
import {type Worker,type Job,type Conversation,type Delivery,record} from './state.ts';
import type {Runtime} from './runtime.ts';
const exec=promisify(execFile);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
interface Fresh {
 id:string;key:string;workerId:string;owner:string;organization:string;conversationId:string;taskId:string;
 requestDigest:string;expected:string;original:Worker;authorizationReference:string;handoffReference:string;instruction:string;
 quarantined:Delivery[];git:unknown;generation:number;paneId?:string;sessionId?:string;deliveryId?:string;
 retireIdlePane?:boolean;retainedProcess?:unknown;
 phase:'reserved'|'closing'|'creating'|'starting'|'waiting'|'queued'|'uncertain';createdAt:number;
}
/** Explicit new provider session. Never claims continuity with an unbound old session. */
export class FreshContinuation {
 readonly runtime:Runtime;
 constructor(runtime:Runtime){this.runtime=runtime;}
 context(job:Job,id:string){
  const r=this.runtime,w=r.state.get<Worker>('workers',id),c=r.state.get<Conversation>('conversations',job.conversationId);
  if(!w || !c?.owner || !c.metadata.sokosumi_organization_id || w.conversationId!==c.id || !r.ownsWorker(job,w) || r.job(job.id).status!=='in_progress' || !(job.kind==='chat' || (job.kind==='worker' && job.workerId===w.id && job.taskId===w.taskId && w.freshContinuationId)))throw new ControlConflict('New-session continuation requires the exact active owner conversation');
  return {w,c};
 }
 async task(w:Worker,c:Conversation){
  try{const task=record((await this.runtime.api(`/tasks/${encodeURIComponent(w.taskId!)}`,'GET',undefined,this.runtime.contextHeaders(c))).data);this.runtime.assertTaskOwner(task,c);if(task.assigneeId!==this.runtime.config.coworkerId)throw new Error('assignment changed');this.runtime.validateWorkerProject(w,task);return task;}catch{throw new ControlConflict('Task ownership/assignment/executable state could not be verified; no fresh continuation');}
 }
 eligible(w:Worker){
  if(w.recoveryHold || w.state==='blocked')throw new ControlConflict('Existing approval hold must be reconciled; fresh session cannot bypass it');
  if(!(this.runtime.config.workerKinds??['codex','claude']).includes(w.kind??'codex') || w.kind==='grok')throw new ControlConflict('Fresh continuation requires an enabled Codex/Claude provider');
  if(!w.taskId)throw new ControlConflict('Retained assigned task required');
  if(this.runtime.state.all<{path:string;status:string}>('outbox').some(o=>o.path===`/tasks/${encodeURIComponent(w.taskId!)}/events` && ['sending','uncertain'].includes(o.status)))throw new ControlConflict('Task report outcome is unresolved; reconcile before starting different work');
 }
 snapshot(w:Worker,c:Conversation){
  const ds=this.runtime.state.all<Delivery>('deliveries').filter(d=>d.workerId===w.id);
  const identity={...w,observedAt:undefined,error:undefined,state:undefined,idleSince:undefined};
  return {digest:hash([identity,c.owner,c.metadata.sokosumi_organization_id,ds]),deliveries:ds};
 }
 async git(w:Worker){
  const run=async(...a:string[])=>(await exec('git',['-C',w.worktree,...a],{maxBuffer:2*1024*1024})).stdout;
  const branch=(await run('branch','--show-current')).trim();
  if(branch!==w.branch)throw new ControlConflict('Retained worktree branch changed; reconcile Git before continuation');
  return {head:(await run('rev-parse','HEAD')).trim(),branch,status:await run('status','--porcelain=v1'),diffDigest:hash(await run('diff','HEAD','--'))};
 }
 async plan(job:Job,id:string){
  const {w,c}=this.context(job,id);this.eligible(w);const git=await this.git(w);
  const current=this.context(job,id);if(this.snapshot(w,c).digest!==this.snapshot(current.w,current.c).digest)throw new ControlConflict('Worker changed during plan');
  const s=this.snapshot(w,c);
  const retainedProcess=await this.retained(w);
  return {workerId:id,taskId:w.taskId,expectedSnapshot:hash([s.digest,git,retainedProcess]),git,retainedProcess,quarantineDeliveryIds:s.deliveries.filter(d=>['queued','uncertain'].includes(d.status)).map(d=>d.id).sort(),requirements:['Reconciled Git/PR/results handoff','Explicit NEW session; no historical replay','No retained live agent or non-shell process','No approval hold or in-flight instruction'],receipt:w.freshContinuationId?this.runtime.state.get('freshContinuations',w.freshContinuationId):undefined};
 }
 async retained(w:Worker){
  const agents=await this.runtime.herdr.agents();const found=agents.filter(a=>a.pane_id===w.paneId || a.name===w.name || a.cwd===w.worktree);
  if(!found.length)return null;
  if(found.length!==1 || !w.paneId || found[0].pane_id!==w.paneId || found[0].name!==w.name || found[0].cwd!==w.worktree || found[0].agent!==(w.kind??'codex'))throw new ControlConflict('Ambiguous retained process identity; no replacement');
  const info=record(record(await this.runtime.herdr.call(['pane','process-info','--pane',w.paneId])).process_info);
  if(!Array.isArray(info.foreground_processes) || !info.foreground_processes.length)throw new ControlConflict('Cannot verify retained foreground process');
  return {paneId:w.paneId,agent:found[0],process:info};
 }
 async empty(w:Worker){
  const r=this.runtime,agents=await r.herdr.agents();
  if(agents.some(a=>a.pane_id===w.paneId || a.name===w.name || a.cwd===w.worktree))throw new ControlConflict('Retained live agent exists. Coordinator must explicitly stop the inspected idle session before choosing a new-session continuation; never close a held or busy session');
  if(w.paneId){
   const workspace=r.state.get<string>('meta','workspace');if(!workspace)throw new ControlConflict('Workspace missing');
   const list=await r.herdr.call(['pane','list','--workspace',workspace]);
   if(!Array.isArray(list.panes))throw new ControlConflict('Cannot verify retained pane');
   if(list.panes.some(p=>record(p).pane_id===w.paneId)){
    const info=record(record(await r.herdr.call(['pane','process-info','--pane',w.paneId])).process_info);
    const ps=Array.isArray(info.foreground_processes)?info.foreground_processes.map(record):[];
    if(ps.length!==1 || ps[0].pid!==info.shell_pid)throw new ControlConflict('Retained pane still owns a process; no new session started');
    return true;
   }
  }
  return false;
 }
 current(job:Job,g:Fresh){
  const {w,c}=this.context(job,g.workerId);this.eligible(w);
  if(c.owner!==g.owner || c.metadata.sokosumi_organization_id!==g.organization || w.taskId!==g.taskId || w.freshContinuationId!==g.id || w.generation!==g.generation || w.paneId!==g.paneId || w.worktree!==g.original.worktree || w.branch!==g.original.branch || w.name!==g.original.name || w.kind!==g.original.kind || w.sessionId!==g.sessionId)throw new ControlConflict('Fresh continuation identity changed; inspect its receipt');
  return {w,c};
 }
 async run(job:Job,id:string,e:Record<string,unknown>){
  const r=this.runtime,{w,c}=this.context(job,id);this.eligible(w);
  if(typeof e.key!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(e.key))throw new ControlConflict('A stable explicit new-session operation key is required');
  const lookup=`${id}:${e.key}`,known=r.state.get<string>('freshContinuationKeys',lookup);
  let g=known?r.state.get<Fresh>('freshContinuations',known):undefined;
  const prior=w.freshContinuationId?r.state.get<Fresh>('freshContinuations',w.freshContinuationId):undefined;
  if(!g && prior && prior.phase!=='queued')throw new ControlConflict('Prior new-session operation is pending or uncertain; do not replace its key');
  if(g){
   if(g.requestDigest!==hash(e))throw new ControlConflict('Existing fresh continuation differs; inspect receipt rather than replacing it');
   if(g.phase==='queued'){
    const d=r.state.get<Delivery>('deliveries',g.deliveryId!);
    if(g.owner!==c.owner || g.organization!==c.metadata.sokosumi_organization_id || w.taskId!==g.taskId || w.paneId!==g.paneId || w.sessionId!==g.sessionId || w.archivedAt || w.archiveRequestedAt || !d || !['queued','sent'].includes(d.status) || w.generation!==(d.status==='sent'?g.generation+1:g.generation))throw new ControlConflict(`Fresh receipt ${g.id} belongs to a changed lifecycle/delivery; no new session or replay`);
    return this.result(g);
   }
   if(['closing','creating','starting','uncertain'].includes(g.phase))throw new ControlConflict(`Fresh continuation ${g.id} has an uncertain ${g.phase} outcome; no retry or replay`);
   this.current(job,g);
  }else{
   if(job.kind!=='chat')throw new ControlConflict('Only owner chat can authorize a new-session handoff');
   if(e.newSession!==true || e.noHistoricalReplay!==true || typeof e.instruction!=='string' || !e.instruction.trim() || e.instruction.length>24000 || typeof e.authorizationReference!=='string' || !e.authorizationReference.trim() || e.authorizationReference.length>1000 || typeof e.handoffReference!=='string' || !e.handoffReference.trim() || e.handoffReference.length>1000)throw new ControlConflict('Explicit newSession/noHistoricalReplay, bounded new instruction, authorization and reconciled Git/PR/result handoff references required');
   const plan=await this.plan(job,id);if(e.expectedSnapshot!==plan.expectedSnapshot || JSON.stringify(e.quarantineDeliveryIds)!==JSON.stringify(plan.quarantineDeliveryIds))throw new ControlConflict('Fresh continuation snapshot/quarantine list changed; inspect plan again');
   if(this.snapshot(w,c).deliveries.some(d=>d.status==='sending'))throw new ControlConflict('Instruction still in flight; wait for its outcome, never branch around it');
   const retained=plan.retainedProcess;
   if(retained && (e.retireIdleSession!==true || !['idle','done'].includes(retained.agent.agent_status)))throw new ControlConflict('Explicit retirement of the exact inspected idle session required; held/busy sessions cannot be replaced');
   const reusablePane=retained?false:await this.empty(w);
   const task=await this.task(w,c);
   if(!['READY','RUNNING','COMPLETED'].includes(String(task.status)))throw new ControlConflict('Task is canceled or requires external input; no fresh continuation');
   const latest=await this.plan(job,id);if(latest.expectedSnapshot!==plan.expectedSnapshot)throw new ControlConflict('Worker or Git changed during continuation preflight');
   g={id:randomUUID(),key:e.key,workerId:id,owner:c.owner,organization:c.metadata.sokosumi_organization_id!,conversationId:c.id,taskId:w.taskId!,requestDigest:hash(e),expected:plan.expectedSnapshot,original:w,git:plan.git,authorizationReference:e.authorizationReference,handoffReference:e.handoffReference,instruction:e.instruction,quarantined:this.snapshot(w,c).deliveries.filter(d=>['queued','uncertain'].includes(d.status)),generation:(w.generation??0)+1,paneId:retained?w.paneId:reusablePane?w.paneId:undefined,retireIdlePane:Boolean(retained),retainedProcess:retained,phase:'reserved',createdAt:Date.now()};
   const grant=g;
   r.state.transaction(()=>{
    if(this.snapshot(this.context(job,id).w,c).digest!==this.snapshot(w,c).digest)throw new ControlConflict('Concurrent worker change');
    if(r.state.get('freshContinuationKeys',lookup))throw new ControlConflict('Fresh operation already reserved');
    r.state.put('freshContinuationKeys',lookup,grant.id);
    r.state.put('freshContinuations',grant.id,grant);
    for(const out of r.state.all<import('./state.ts').Outbox>('outbox'))if(out.path===`/tasks/${encodeURIComponent(w.taskId!)}/events` && out.status==='pending' && out.body.status==='COMPLETED')r.state.put('outbox',out.id,{...out,status:'superseded',blockedReason:`Explicit follow-up ${grant.id}`});
    for(const d of grant.quarantined)r.state.put('deliveries',d.id,{...d,status:'quarantined',quarantineId:grant.id,priorStatus:d.status});
    r.state.put('workers',id,{...w,freshContinuationId:grant.id,paneId:grant.paneId,sessionId:undefined,sessionEvidenceReference:undefined,generation:grant.generation,state:'starting',priorResult:w.result??w.priorResult,archivedAt:undefined,archiveRequestedAt:undefined,recoveryEpoch:(w.recoveryEpoch??0)+1});
   });
  }
  const save=()=>r.state.put('freshContinuations',g!.id,g);
  const claim=(phase:Fresh['phase'])=>r.state.transaction(()=>{
   this.current(job,g!);
   if(r.state.get<Fresh>('freshContinuations',g!.id)?.phase!==g!.phase)throw new ControlConflict('Fresh continuation phase already claimed; no duplicate effect');
   g!.phase=phase;save();
  });
  if(g.phase==='reserved' && g.retireIdlePane){
   const retained=await this.retained(this.current(job,g).w);
   if(hash(retained)!==hash(g.retainedProcess) || !retained || !['idle','done'].includes(retained.agent.agent_status))throw new ControlConflict('Retained idle process changed before explicit retirement');
   claim('closing');
   try{await r.herdr.call(['pane','close',g.paneId!]);}catch{g.phase='uncertain';save();throw new ControlConflict('Retirement outcome uncertain; inspect receipt, no close replay or new launch');}
   const current=this.current(job,g).w;
   g.paneId=undefined;g.retireIdlePane=false;g.phase='reserved';
   r.state.transaction(()=>{r.state.put('workers',id,{...current,paneId:undefined});save();});
  }
  if(g.phase==='reserved'){
   await this.empty(this.current(job,g).w);
   if(!g.paneId){
    const workspace=r.state.get<string>('meta','workspace');if(!workspace)throw new ControlConflict('Workspace missing');
    claim('creating');
    try{g.paneId=paneFrom(await r.herdr.call(['tab','create','--workspace',workspace,'--cwd',w.worktree,'--label',w.name,'--no-focus']));}
    catch{g.phase='uncertain';save();throw new ControlConflict('Pane creation outcome uncertain; inspect receipt, no duplicate creation');}
    const current=r.state.get<Worker>('workers',id)!;
    if(current.freshContinuationId!==g.id || current.generation!==g.generation || current.paneId!==undefined){g.phase='uncertain';save();throw new ControlConflict('Worker changed after pane creation; retained resource receipt, no agent started');}
    r.state.put('workers',id,{...current,paneId:g.paneId});save();
   }
   claim('starting');
   try{await r.herdr.call(['agent','start',w.name,'--kind',w.kind??'codex','--pane',g.paneId!,'--',...(w.kind==='claude'?['--permission-mode','acceptEdits']:['-C',w.worktree,'--no-alt-screen','-s','danger-full-access','-a','never'])]);}
   catch{g.phase='uncertain';save();throw new ControlConflict('Fresh agent start outcome uncertain; inspect receipt, never relaunch automatically');}
   g.phase='waiting';save();
  }
  const {w:current,c:owner}=this.current(job,g);
  const agents=await r.herdr.agents();this.current(job,g);
  const candidates=agents.filter(a=>a.pane_id===g!.paneId || a.name===w.name || a.cwd===w.worktree);
  const live=candidates[0];
  if(candidates.length!==1 || live.pane_id!==g.paneId || live.name!==w.name || live.cwd!==w.worktree || live.agent!==(w.kind??'codex') || !live.agent_session_id || !['idle','done'].includes(live.agent_status))return {...this.result(g),reason:'New session started; waiting for exact native session identity and idle prompt. No instruction delivered. Inspect supported provider integration or current startup dialog.'};
  const task=await this.task(current,owner);this.current(job,g);
  if(!['READY','RUNNING','COMPLETED'].includes(String(task.status)))throw new ControlConflict('Task no longer permits continuation');
  r.state.transaction(()=>{
   const fresh=this.current(job,g!).w;
   g!.sessionId=live.agent_session_id;
   r.state.put('workers',id,{...fresh,sessionId:g!.sessionId,sessionEvidenceReference:`fresh:${g!.id}`,state:'idle'});
   const instruction=`This is an explicitly authorized NEW provider session in the SAME tracked task and worktree, not historical session recovery. Reconcile Git, existing PRs and prior results using handoff ${g!.handoffReference}. Historical instruction IDs ${g!.quarantined.map(d=>d.id).join(', ')||'(none)'} are quarantined: do not replay them or infer their outcomes. Pending approvals are not granted.\n\n${g!.instruction}`;
   g!.phase='queued';save();
   g!.deliveryId=r.queueInstruction(r.state.get<Worker>('workers',id)!,instruction).id;g!.phase='queued';save();
   if(task.status==='COMPLETED')r.reportTask(g!.taskId,'Explicitly authorized follow-up queued in a new provider session; prior work and results retained.','RUNNING');
  });
  return this.result(g);
 }
 result(g:Fresh){return {workerId:g.workerId,taskId:g.taskId,receiptId:g.id,key:g.key,newSession:true,phase:g.phase,paneId:g.paneId,sessionId:g.sessionId,deliveryId:g.deliveryId,quarantineDeliveryIds:g.quarantined.map(d=>d.id),note:'Queued/transport receipts are not proof of work or task completion'};}
}
