import { createHash } from "node:crypto";
import { State, type Conversation, type Job, type Outbox, type Worker } from "./state.ts";
import { failureText } from "./recovery.ts";

export type NoticeKind = "failure" | "blocked" | "recovered";
export interface Incident {
  id: string; conversationId: string; owner: string; organization: string;
  source: "turn" | "worker" | "delivery" | "monitor"; sourceId: string;
  httpStatus?: number;
  rejectionKind?: string;
  kind: NoticeKind; cause: string; taskId?: string; workerId?: string;
  createdAt: number; attempts: number; reviewedAt?: number; fallback?: boolean;
  episodeEndedAt?: number;
  resolvedAt?: number;
  notificationMissing?: boolean;
  reviewFailure?: string; notificationIds?: string[];
}
const causes = new Set(["turn_timeout","turn_oom_killed","turn_signal","turn_interrupted","turn_exit_failure","turn_empty_output","recovery_required","recovery_limit","runner_error","provider_policy","provider_auth","provider_usage_limit","provider_rate_limit","provider_context_limit","provider_connection","provider_failure","worker_blocked","worker_missing","worker_recovered","turn_recovered","delivery_failed","delivery_uncertain","monitor_unavailable"]);
export function safeCause(value: unknown): string { return typeof value === "string" && causes.has(value) ? value : "unknown_failure"; }
export function causeText(cause: string): string {
  const fixed: Record<string, string> = {
    worker_blocked:"A worker requires attention; do not infer or grant approval.",
    worker_missing:"The worker process could not be confirmed; task completion is unknown.",
    turn_recovered:"The interrupted orchestration turn completed after authorized recovery; this does not prove the parent task is complete.",
    worker_recovered:"The existing worker session was restored; task completion remains unverified.",
    delivery_failed:"An update was rejected or could not be delivered.",
    delivery_uncertain:"An update may have been accepted; do not resend without reconciliation.",
    monitor_unavailable:"Worker monitoring or task polling is unavailable; live state is unknown.",
    unknown_failure:"The operation failed; the cause is not yet verified.",
  };
  return Object.hasOwn(fixed,cause) ? fixed[cause] : failureText(cause);
}
export const INCIDENT_INSTRUCTION = `You are the CodePat orchestrator, the user's single conversational contact. Review only the structured incidents supplied in this conversation. Explain affected work, verified cause versus unknown, stopped/blocked status and concrete next steps, with supplied task links. Do not quote raw worker reports or private diagnostics. This turn is notification-only: it does not authorize retrying the failed operation, provider-policy workarounds, approval, sends, new tasks/workers or recovery. Return a concise user-facing explanation; the bridge labels it as an orchestrator incident update. Return [NO_UPDATE] only if no new information warrants a notice. Notification failure is retained, not recursively retried.`;
interface Episode { sequence: number; active: boolean; incidentId?: string }
type IncidentInput = Pick<Incident,"source"|"sourceId"|"kind"|"cause"> & Partial<Pick<Incident,"taskId"|"workerId"|"httpStatus"|"rejectionKind">>;
export class Incidents {
  readonly state: State;
  constructor(state: State) { this.state=state; }
  owns(i: Incident, c: Conversation): boolean { return i.conversationId===c.id && i.owner===c.owner && i.organization===(c.metadata.sokosumi_organization_id ?? ""); }
  record(c: Conversation, input: IncidentInput, now=Date.now()): Incident {
    const id=createHash("sha256").update(JSON.stringify([c.id,c.owner,c.metadata.sokosumi_organization_id,input.source,input.sourceId])).digest("hex");
    const old=this.state.get<Incident>("incidents",id); if(old) return old;
    const i:Incident={...input,cause:safeCause(input.cause),id,conversationId:c.id,owner:c.owner,organization:c.metadata.sokosumi_organization_id??"",createdAt:now,attempts:0};
    this.state.put("incidents",id,i); return i;
  }
  private episodeKey(c: Conversation, channel: string): string {
    return createHash("sha256").update(JSON.stringify([c.id,c.owner,c.metadata.sokosumi_organization_id??"",channel])).digest("hex");
  }
  // A restart/undefined in-memory error is not a healthy observation. Only the
  // successful observer or verified recovery path calls healthy().
  observe(c: Conversation, channel: string, input: Omit<IncidentInput,"sourceId">, now=Date.now()): Incident {
    return this.state.transaction(()=>{
      const key=this.episodeKey(c,channel);
      const previous=this.state.get<Episode>("incidentEpisodes",key);
      if(previous?.active && previous.incidentId){
        const incident=this.state.get<Incident>("incidents",previous.incidentId);
        if(!incident || !this.owns(incident,c))throw new Error("Incident episode evidence missing or scope changed");
        return incident;
      }
      const sequence=(previous?.sequence??0)+1;
      const incident=this.record(c,{...input,sourceId:channel+":episode:"+sequence},now);
      this.state.put<Episode>("incidentEpisodes",key,{sequence,active:true,incidentId:incident.id});
      return incident;
    });
  }
  healthy(c: Conversation, channel: string, now=Date.now()): number {
    return this.state.transaction(()=>{
      const key=this.episodeKey(c,channel);
      const previous=this.state.get<Episode>("incidentEpisodes",key);
      if(previous?.active){
        const incident=previous.incidentId ? this.state.get<Incident>("incidents",previous.incidentId) : undefined;
        if(incident && this.owns(incident,c)){incident.episodeEndedAt=now;this.state.put("incidents",incident.id,incident);}
        this.state.put<Episode>("incidentEpisodes",key,{...previous,active:false});
      }
      return previous?.sequence??0;
    });
  }
  list(c: Conversation): Incident[] { return this.state.all<Incident>("incidents").filter(i=>this.owns(i,c)); }
  reconcileDeliveries():void {
    for(const i of this.state.all<Incident>("incidents")){
      if(i.source!=="delivery" || !i.sourceId.startsWith("outbox:") || i.resolvedAt)continue;
      const d=this.state.get<Outbox>("outbox",i.sourceId.slice(7));
      const c=this.state.get<Conversation>("conversations",i.conversationId);
      if(c && this.owns(i,c) && d?.conversationId===i.conversationId && d.status==="sent"){
        i.resolvedAt=Date.now();this.state.put("incidents",i.id,i);
      }
    }
    for(const d of this.state.all<Outbox>("outbox")){
      if(d.status!=="pending" || (d.attempts??0)!==0 || !d.incidentIds?.length)continue;
      if(d.incidentIds.every(id=>Boolean(this.state.get<Incident>("incidents",id)?.resolvedAt))){d.status="superseded";this.state.put("outbox",d.id,d);}
    }
  }
  pending(c: Conversation): Incident[] { this.reconcileDeliveries();return this.list(c).filter(i=>!i.reviewedAt && !i.resolvedAt); }
  view(i: Incident) {
    const w=i.workerId ? this.state.get<Worker>("workers",i.workerId) : undefined;
    return {...i, explanation:i.resolvedAt ? "The source update is now confirmed accepted; any uncertain notification still requires reconciliation." : causeText(i.cause),taskUrl:i.taskId ? `https://app.sokosumi.com/tasks/${encodeURIComponent(i.taskId)}`:undefined,
      worker:w && w.conversationId===i.conversationId ? {id:w.id,state:w.state,observedAt:w.observedAt,recoveryHold:Boolean(w.recoveryHold),resultAvailable:Boolean(w.result)} : undefined,
      notifications:(i.notificationIds??[]).map(id=>{
        const delivery=this.state.get<Outbox>("outbox",id);
        return {id,status:delivery?.status??"unknown",httpStatus:delivery?.httpStatus,rejectionKind:delivery?.rejectionKind};
      })};
  }
  context(c: Conversation, advance=false) {
    this.reconcileDeliveries();
    const all=this.list(c).filter(i=>!i.resolvedAt || (i.notificationIds??[]).some(id=>["pending","sending","uncertain","failed"].includes(this.state.get<Outbox>("outbox",id)?.status??"")));
    const selected=all.filter(i=>!i.reviewedAt || i.notificationMissing || (i.notificationIds??[]).some(id=>["pending","sending","uncertain","failed"].includes(this.state.get<Outbox>("outbox",id)?.status??"")));
    const offset=selected.length ? (this.state.get<number>("incidentContextOffset",c.id)??0)%selected.length : 0;
    if(advance && selected.length)this.state.put("incidentContextOffset",c.id,(offset+20)%selected.length);
    const page=[...selected.slice(offset),...selected.slice(0,offset)].slice(0,20);
    return {pending: page.map(i=>this.view(i)),total:selected.length,
      instruction:"Use incident-report for a verified explanation from a normal turn. Do not confuse notification acceptance with recipient reading, or reviewed incident with completed work. Uncertain delivery must not be replayed. HTTP rejection is not proof of no side effects: insufficient_balance may include a committed pause event; reconcile before any retry."};
  }
  schedule(now=Date.now()): void {
    this.state.transaction(()=>{
      const jobs=this.state.all<Job>("jobs");
      if(jobs.some(j=>j.status==="in_progress")) return;
      for(const c of this.state.all<Conversation>("conversations")){
        if(!c.owner || !c.metadata.sokosumi_organization_id) continue;
        if(jobs.some(j=>j.conversationId===c.id && j.kind==="incident" && ["queued","in_progress"].includes(j.status))) continue;
        if(now<(this.state.get<number>("incidentNextAt",c.id)??0)) continue;
        const items=this.pending(c).filter(i=>i.attempts===0).slice(0,10);
        if(!items.length) continue;
        // At most one autonomous attempt per incident; a later user turn still sees it.
        for(const i of items){i.attempts++;this.state.put("incidents",i.id,i);}
        const job=this.state.enqueue({kind:"incident",conversationId:c.id,input:INCIDENT_INSTRUCTION,incidentIds:items.map(i=>i.id),reviewOwner:c.owner,reviewOrganization:c.metadata.sokosumi_organization_id});
        jobs.push(job); this.state.put("incidentNextAt",c.id,now+300_000);
      }
    });
  }
  selected(job:Job): Incident[] {
    this.reconcileDeliveries();
    const c=this.state.get<Conversation>("conversations",job.conversationId);
    if(!c || (job.kind==="incident" && (job.reviewOwner!==c.owner || job.reviewOrganization!==c.metadata.sokosumi_organization_id)))return [];
    return (job.incidentIds??[]).flatMap(id=>{const i=this.state.get<Incident>("incidents",id);return i && this.owns(i,c) && !i.reviewedAt && !i.resolvedAt ? [i]:[];});
  }
}
export function noticeText(kind:NoticeKind,text:string,items:Pick<Incident,"taskId">[],automated=false):string {
  const label=automated ? "Automated system notice — orchestrator unavailable" : `CodePat — ${kind==="recovered"?"Recovery update":kind==="blocked"?"Work blocked":"Failure update"}`;
  const links=[...new Set(items.flatMap(i=>i.taskId?[i.taskId]:[]))].map(id=>`[Task](https://app.sokosumi.com/tasks/${encodeURIComponent(id)})`).join(" · ");
  return `**${label}**\n\n${text}${links?"\n\n"+links:""}`;
}
