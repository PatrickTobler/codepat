import {ControlConflict} from "./control-error.ts";
import {createHash,randomUUID} from 'node:crypto';
import {State,record,textField,type Worker,type Conversation,type Delivery,type Outbox} from './state.ts';
import {ACTION_TEXT_VERSION,canonicalActionText} from './action-text.ts';
export interface WorkerHold {
  id:string;workerId:string;generation:number;paneId:string;taskId?:string;
  conversationId:string;owner:string;organization:string;createdAt:number;
  actionDigest?:string;actionTextDigest?:string;actionTextVersion?:number;evidenceReference?:string;recordedByJob?:string;
  decision?:'approved'|'denied'|'cancelled';decisionReference?:string;resolvedAt?:number;
  sessionId?:string;dialogFingerprint?:string;
  routineApprovedAt?:number;routineApprovalReference?:string;
  retiredDeliveryIds?:string[];resolvedByJob?:string;
}
export class WorkerHolds {
  state:State;
  constructor(state:State){this.state=state;}
  observe(w:Worker,c:Conversation):void{
    if(w.recoveryHold || !w.paneId)return; // Never manufacture provenance for legacy boolean holds.
    const h:WorkerHold={id:randomUUID(),workerId:w.id,generation:w.generation??0,paneId:w.paneId,taskId:w.taskId,conversationId:c.id,owner:c.owner,organization:c.metadata.sokosumi_organization_id??'',createdAt:Date.now()};
    this.state.put('workerHolds',h.id,h);w.holdId=h.id;
  }
  bound(w:Worker,c:Conversation,input:unknown):{hold:WorkerHold;evidence:Record<string,unknown>}{
    const e=record(input);const h=this.state.get<WorkerHold>('workerHolds',textField(e,'holdId'));
    if(!h || w.holdId!==h.id || h.workerId!==w.id || h.generation!==(w.generation??0) || e.generation!==h.generation || h.paneId!==w.paneId || e.paneId!==h.paneId || h.taskId!==w.taskId || h.conversationId!==c.id || h.owner!==c.owner || h.organization!==(c.metadata.sokosumi_organization_id??''))throw new ControlConflict('Hold identity/scope changed or provenance unknown');
    return {hold:h,evidence:e};
  }
  recordAction(w:Worker,c:Conversation,input:unknown,jobId:string){
    const {hold:h,evidence:e}=this.bound(w,c,input);
    if(!w.recoveryHold || h.resolvedAt)throw new ControlConflict('Hold is not active');
    const digest=textField(e,'actionDigest'),reference=textField(e,'evidenceReference'),actionText=typeof e.actionText==='string'?e.actionText:'';
    if(!/^[a-f0-9]{64}$/.test(digest) || reference.length>1000 || actionText.length>2000)throw new ControlConflict('Exact action digest and bounded private evidence reference required');
    if(h.actionDigest && h.actionTextVersion!==ACTION_TEXT_VERSION)throw new ControlConflict('Existing action provenance has no recognized canonicalization version; create a fresh hold');
    if(h.actionDigest && (h.actionDigest!==digest || h.evidenceReference!==reference))throw new ControlConflict('Recorded action evidence cannot be replaced');
    const actionTextDigest=actionText ? createHash('sha256').update(canonicalActionText(actionText)).digest('hex') : undefined;
    if(h.actionDigest && (h.actionTextDigest!==actionTextDigest && actionTextDigest))throw new ControlConflict('Recorded action evidence cannot be replaced');
    if(h.sessionId && h.sessionId!==e.sessionId)throw new ControlConflict('Recorded action session changed; hold retained');
    if(h.dialogFingerprint && h.dialogFingerprint!==e.dialogFingerprint)throw new ControlConflict('Recorded dialog fingerprint changed; hold retained');
    if(typeof e.sessionId==='string')h.sessionId=e.sessionId;
    if(typeof e.dialogFingerprint==='string')h.dialogFingerprint=e.dialogFingerprint;
    h.actionDigest=digest;if(actionTextDigest){h.actionTextDigest=actionTextDigest;h.actionTextVersion=ACTION_TEXT_VERSION;}h.evidenceReference=reference;h.recordedByJob=jobId;
    this.state.put('workerHolds',h.id,h);return {ok:true,holdId:h.id,actionDigest:digest};
  }
  resolve(w:Worker,c:Conversation,input:unknown,jobId:string){
    return this.state.transaction(()=>{
      const e=record(input), saved=e.holdId ? this.state.get<WorkerHold>('workerHolds',textField(e,'holdId')) : undefined;
      if(saved?.resolvedAt && saved.workerId===w.id && saved.conversationId===c.id && saved.owner===c.owner && saved.organization===(c.metadata.sokosumi_organization_id??'') && w.holdId===saved.id && w.taskId===saved.taskId){
        if(textField(e,'decision')!==saved.decision || textField(e,'decisionReference')!==saved.decisionReference)throw new ControlConflict('Resolution conflicts with prior decision');
        return {ok:true,holdId:saved.id,decision:saved.decision,resolvedAt:saved.resolvedAt};
      }
      const {hold:h,evidence}=this.bound(w,c,input);
      const decision=textField(evidence,'decision'),reference=textField(evidence,'decisionReference');
      const digest=textField(evidence,'actionDigest'), evidenceReference=textField(evidence,'evidenceReference');
      if(!['approved','denied','cancelled'].includes(decision) || reference.length>1000 || !/^[a-f0-9]{64}$/.test(digest))throw new ControlConflict('Known exact action and human decision evidence required');
      const receiptId=createHash('sha256').update(JSON.stringify([w.id,w.generation??0,w.paneId,digest])).digest('hex');
      const approval=this.state.get<{status:string;holdId?:string;sessionId?:string}>('routineApprovals',receiptId);
      if(reference.startsWith('routine:') && (reference!==`routine:${receiptId}` || approval?.status!=='accepted' || approval.holdId!==h.id || approval.sessionId!==h.sessionId || decision!=='approved'))
        throw new ControlConflict('Routine decision reference requires the exact accepted approval receipt; acknowledgement is not command success');
      if(approval && ['sending','uncertain'].includes(approval.status)) {
        if(evidence.approvalReceiptId!==receiptId || typeof evidence.keyOutcomeReference!=='string' || !evidence.keyOutcomeReference.trim() || evidence.keyOutcomeReference.length>1000)
          throw new ControlConflict('Uncertain approval key requires exact approvalReceiptId and private keyOutcomeReference from actual inspection/human action; never replay it');
      }
      if(h.routineApprovedAt && decision!=='approved')throw new ControlConflict('Routine approval was already accepted; denial or cancellation cannot be recorded');
      // A dialog can close before its action digest is recorded. An owner may
      // attest the exact action and decision together while the durable hold,
      // identity and idle/done pane are still bound by the caller. This never
      // applies to a legacy boolean-only hold with no hold receipt.
      if(!h.actionDigest){
        if(!evidenceReference || evidenceReference.length>1000)throw new ControlConflict('Closed dialog needs bounded action evidence reference');
        if(typeof e.sessionId==='string')h.sessionId=e.sessionId;
        h.actionDigest=digest;h.evidenceReference=evidenceReference;
      } else if(evidence.actionDigest!==h.actionDigest)throw new ControlConflict('Known exact action and human decision evidence required');
      if(h.resolvedAt){
        if(h.decision!==decision || h.decisionReference!==reference)throw new ControlConflict('Resolution conflicts with prior decision');
        return {ok:true,holdId:h.id,decision:h.decision,resolvedAt:h.resolvedAt};
      }
      if(!w.recoveryHold)throw new ControlConflict('Hold state changed');
      const deliveries=this.state.all<Delivery>('deliveries').filter(d=>d.workerId===w.id);
      if(deliveries.some(d=>['sending','uncertain'].includes(d.status)))throw new ControlConflict('Unresolved instruction outcomes prevent reconciliation');
      if(this.state.all<Outbox>('outbox').some(d=>d.conversationId===c.id && ['sending','uncertain'].includes(d.status)))throw new ControlConflict('Unresolved conversation delivery outcomes prevent reconciliation');
      if(this.state.all<{conversationId?:string;status:string}>('directSends').some(d=>d.conversationId===c.id && ['sending','uncertain'].includes(d.status)))throw new ControlConflict('Unresolved direct send outcomes prevent reconciliation');
      const queued=deliveries.filter(d=>d.status==='queued');
      const retire=Array.isArray(e.retireDeliveryIds)?e.retireDeliveryIds:[];
      const expected=decision==='approved'?[]:queued.map(d=>d.id);
      if(JSON.stringify([...retire].sort())!==JSON.stringify(expected.sort()))throw new ControlConflict('Exact queued delivery retirement list required for denial/cancellation');
      for(const d of queued.filter(d=>retire.includes(d.id))){d.status='superseded';d.blockedReason='Retired by recorded human denial/cancellation';this.state.put('deliveries',d.id,d);}
      h.decision=decision as WorkerHold['decision'];h.decisionReference=reference;h.resolvedAt=Date.now();h.resolvedByJob=jobId;h.retiredDeliveryIds=retire as string[];
      w.recoveryHold=false;
      if(decision!=='approved')w.state='stopped';
      else if(['blocked','recovery_blocked'].includes(w.state))w.state='idle';
      if(approval)this.state.put('routineApprovals',receiptId,{...this.state.get<Record<string,unknown>>('routineApprovals',receiptId),reconciledAt:h.resolvedAt,decision,decisionReference:reference,keyOutcomeReference:evidence.keyOutcomeReference});
      this.state.put('workerHolds',h.id,h);this.state.put('workers',w.id,w);
      return {ok:true,holdId:h.id,decision:h.decision,resolvedAt:h.resolvedAt};
    });
  }
}
