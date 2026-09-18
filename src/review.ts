import { createHash } from "node:crypto";
import { type Conversation, type Delivery, type Job, type Outbox, type Worker, State } from "./state.ts";

export const REVIEW_INSTRUCTION = `Review owned unfinished tasks, worker progress, queued instructions and failed deliveries. Continue authorized next steps, repair routine failures, and resume existing workers where safe. Reconcile outcomes before retrying external actions. Escalate unresolved blockers and preserve human approval requirements. Stay silent when no action or new information warrants a message. Never infer completion from idle/done alone.
This is a periodic review, not new user authorization. Do not create new workers/tasks, merge, deploy, accept approvals or repeat uncertain sends. Review only this conversation. Use review-work to retain authorized remaining stages (pending), record a user/approval wait (waiting), or close verified finished work (done). An open PR alone does not authorize continuation. Reuse existing worker/task identities. Return exactly [NO_UPDATE] when no new information warrants a notification. Keep any update concise; do not repeat unchanged blockers. Use the configured background turn deadline; finish promptly.`;
export function reviewInterval(value: unknown = 1_200_000): number {
  const n = Number(value);
  if (!Number.isInteger(n) || (n !== 0 && (n < 60_000 || n > 86_400_000)))
    throw new Error("CODEPAT_REVIEW_INTERVAL_MS must be 0 (disabled) or 60000..86400000");
  return n;
}
export interface ReviewWork { workerId: string; state: "pending" | "waiting" | "done"; note: string }
export interface ReviewSchedule { owner: string; organization: string; nextAt: number; sequence: number; lastNotified?: string }
export class Reviews {
  readonly state: State;
  readonly interval: number;
  constructor(state: State, interval: number) { this.state = state; this.interval = interval; }
  evidence(c: Conversation) {
    const workers = this.state.all<Worker>("workers").filter(w => w.conversationId === c.id);
    const eligible = workers.filter(w => {
      const parent = w.taskId && this.state.get<string>("reviewTaskStatus", w.taskId);
      if (parent && ["COMPLETED", "FAILED", "CANCELED", "REASSIGNED"].includes(parent)) return false;
      const plan = this.state.get<ReviewWork>("reviewWork", w.id);
      if (plan) return plan.state === "pending";
      return !["completed", "stopped"].includes(w.state);
    });
    const deliveries = this.state.all<Delivery>("deliveries").filter(d => workers.some(w => w.id === d.workerId) && ["queued", "sending", "uncertain"].includes(d.status));
    const outbox = this.state.all<Outbox>("outbox").filter(o => o.conversationId === c.id && ["pending", "sending", "uncertain", "failed"].includes(o.status));
    // Never include prompts, transcripts, tool output or unbounded private errors.
    const snapshot = {
      workers: eligible.map(w => ({ id: w.id, taskId: w.taskId, state: w.state, generation: w.generation, resultAvailable: Boolean(w.result), hold: w.recoveryHold, plan: this.state.get<ReviewWork>("reviewWork", w.id) })),
      deliveries: deliveries.map(d => ({ id: d.id, workerId: d.workerId, status: d.status })),
      outbox: outbox.map(o => ({ id: o.id, status: o.status })),
    };
    return { snapshot, fingerprint: createHash("sha256").update(JSON.stringify({ ...snapshot, outbox: snapshot.outbox.filter(o => !outbox.find(item => item.id === o.id)?.reviewNotification && !outbox.find(item => item.id === o.id)?.incidentIds?.length) })).digest("hex"), needed: Boolean(eligible.length || deliveries.length || outbox.length) };
  }
  context(c: Conversation) {
    const { snapshot } = this.evidence(c);
    const schedule = this.state.get<ReviewSchedule>("reviewSchedules", c.id);
    const offset = snapshot.workers.length ? ((schedule?.sequence ?? 1) - 1) * 20 % snapshot.workers.length : 0;
    const workers = [...snapshot.workers.slice(offset), ...snapshot.workers.slice(0, offset)].slice(0, 20);
    return { workers: workers.map(w => ({ ...w, plan: w.plan ? { ...w.plan, note: w.plan.note.slice(0, 500) } : undefined })), deliveries: snapshot.deliveries.slice(0, 20), outbox: snapshot.outbox.slice(0, 20), totals: { workers: snapshot.workers.length, deliveries: snapshot.deliveries.length, outbox: snapshot.outbox.length } };
  }
  schedule(now: number): void {
    if (!this.interval) return;
    this.state.transaction(() => {
      const jobs = this.state.all<Job>("jobs");
      for (const c of this.state.all<Conversation>("conversations")) {
        const organization = c.metadata.sokosumi_organization_id;
        if (!c.owner || !organization) continue; // Legacy unknown scope is not permission.
        let schedule = this.state.get<ReviewSchedule>("reviewSchedules", c.id);
        if (schedule && (schedule.owner !== c.owner || schedule.organization !== organization)) continue; // Fail closed on identity changes.
        if (!schedule) {
          schedule = { owner: c.owner, organization, nextAt: now + this.interval, sequence: 0 };
          this.state.put("reviewSchedules", c.id, schedule);
        }
        if (now < schedule.nextAt) continue;
        // One serialized orchestrator. Pending foreground work wins, including after downtime.
        if (jobs.some(j => j.status === "in_progress" || (j.status === "queued" && (j.kind !== "review" || j.conversationId === c.id)))) continue;
        schedule.nextAt = now + this.interval; // No catch-up loop.
        const evidence = this.evidence(c);
        if (evidence.needed) {
          schedule.sequence++;
          const job = this.state.enqueue({ conversationId: c.id, kind: "review", ...(c.metadata.taskId && this.state.get<string>("taskConversations", c.metadata.taskId) === c.id ? { taskId: c.metadata.taskId } : {}), input: REVIEW_INSTRUCTION, reviewOwner: c.owner, reviewOrganization: organization }, `review:${c.id}:${schedule.sequence}`);
          jobs.push(job);
        }
        this.state.put("reviewSchedules", c.id, schedule);
      }
    });
  }
  claim(job: Job, now: number): boolean {
    const c = this.state.get<Conversation>("conversations", job.conversationId);
    if (!this.interval || !c || c.owner !== job.reviewOwner || c.metadata.sokosumi_organization_id !== job.reviewOrganization || !this.evidence(c).needed) {
      job.status = "completed"; job.text = "";
      this.state.put("jobs", job.id, job); return false;
    }
    const schedule = this.state.get<ReviewSchedule>("reviewSchedules", c.id)!;
    schedule.nextAt = now + this.interval;
    this.state.put("reviewSchedules", c.id, schedule);
    job.reviewFingerprint = this.evidence(c).fingerprint;
    return true;
  }
  finish(job: Job, text: string, error?: string): string {
    const schedule = this.state.get<ReviewSchedule>("reviewSchedules", job.conversationId);
    const c = this.state.get<Conversation>("conversations", job.conversationId);
    if (!c || c.owner !== job.reviewOwner || c.metadata.sokosumi_organization_id !== job.reviewOrganization) return "";
    if (error || text.trim() === "[NO_UPDATE]" || !text.trim() || !schedule || schedule.lastNotified === job.reviewFingerprint) return "";
    schedule.lastNotified = job.reviewFingerprint;
    this.state.put("reviewSchedules", job.conversationId, schedule);
    return text.slice(0, 4000);
  }
  status(conversationId: string) {
    return { enabled: this.interval !== 0, intervalMs: this.interval, latest: this.state.all<Job>("jobs").filter(j => j.conversationId === conversationId && j.kind === "review").slice(-1).map(j => ({ id: j.id, status: j.status, error: j.error })), schedule: this.state.get<ReviewSchedule>("reviewSchedules", conversationId), pending: this.state.all<Job>("jobs").filter(j => j.conversationId === conversationId && j.kind === "review" && ["queued", "in_progress"].includes(j.status)).map(j => ({ id: j.id, status: j.status })) };
  }
}
