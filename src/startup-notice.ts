import {createHash} from 'node:crypto';
import {LegacyContinuation} from './legacy-continuation.ts';
import {record,textField,type Worker,type Job,type Delivery} from './state.ts';
import type {Runtime} from './runtime.ts';
// An owner-attested, known update skip is not approval of an agent command.
export async function reconcileStartupNotice(r:Runtime,job:Job,id:string,e:Record<string,unknown>){
  const legacy=new LegacyContinuation(r),{w,c}=legacy.context(job,id);
  const receiptKey=createHash('sha256').update(JSON.stringify([id,c.id,c.owner,c.metadata.sokosumi_organization_id,e])).digest('hex');
  const prior=r.state.get<{workerId:string;resolvedAt:number}>('startupNoticeReceipts',receiptKey);
  if(prior)return {...prior,status:'notice_reconciled',currentHold:Boolean(w.recoveryHold)};
  if(e.notice!=='codex_update_available' || e.decision!=='skip' || e.noCommandApproved!==true || textField(e,'evidenceReference').length>1000)throw new Error('Exact witnessed update-skip provenance required; never infer from idle');
  const snapshot=legacy.snapshot(w,c);
  const check=()=>{
    const fresh=legacy.context(job,id);
    if(legacy.snapshot(fresh.w,fresh.c).digest!==e.expectedSnapshot || e.expectedSnapshot!==snapshot.digest)throw new Error('Startup worker/hold/deliveries changed');
    if((fresh.w.kind??'codex')!=='codex' || (fresh.w.generation??0)!==0 || !fresh.w.recoveryHold || fresh.w.result || !fresh.w.taskId)throw new Error('Only an unstarted Codex worker with a known startup notice is eligible');
    const deliveries=r.state.all<Delivery>('deliveries').filter(d=>d.workerId===id);
    if(deliveries.some(d=>d.status!=='queued'))throw new Error('Prior instruction outcome exists; startup notice classification is insufficient');
    return fresh;
  };
  check();
  const live=await r.workerAgent(w);check();
  if(!live || !['idle','done'].includes(live.agent_status))throw new Error('Exact retained agent must be idle after the witnessed skip');
  const task=record((await r.api(`/tasks/${encodeURIComponent(w.taskId!)}`,'GET',undefined,r.contextHeaders(c))).data);check();
  if(task.assigneeId!==r.config.coworkerId || (task.ownerId??task.userId)!==c.owner || task.organizationId!==c.metadata.sokosumi_organization_id)throw new Error('Live task ownership or assignment changed');
  const finalLive=await r.workerAgent(w);const current=check();
  if(!finalLive || !['idle','done'].includes(finalLive.agent_status))throw new Error('A dialog or active turn appeared; no hold change');
  return r.state.transaction(()=>{
    check();const resolvedAt=Date.now();
    r.state.put('startupNoticeReceipts',receiptKey,{workerId:id,conversationId:c.id,owner:c.owner,organization:c.metadata.sokosumi_organization_id,jobId:job.id,origin:snapshot.identity,notice:e.notice,decision:e.decision,evidenceReference:e.evidenceReference,noCommandApproved:true,resolvedAt});
    if(current.w.holdId){const h=r.state.get<Record<string,unknown>>('workerHolds',current.w.holdId);if(h)r.state.put('workerHolds',current.w.holdId,{...h,resolvedAt,nonApprovalDecision:'update_skipped'});}
    current.w.recoveryHold=false;current.w.state='idle';r.state.put<Worker>('workers',id,current.w);
    const queued=r.state.all<Delivery>('deliveries').filter(d=>d.workerId===id && d.status==='queued').map(d=>d.id);
    return {workerId:id,status:'notice_reconciled',resolvedAt,currentHold:false,queuedDeliveryIds:queued,resumeRequired:queued.length===0};
  });
}
