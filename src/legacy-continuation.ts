import {createHash} from 'node:crypto';
import {existsSync,openSync,readSync,closeSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {record,textField,type Conversation,type Worker,type Delivery,type Job} from './state.ts';
import {paneFrom} from './herdr.ts';
import type {Runtime} from './runtime.ts';
interface Continuation {
  key:string;workerId:string;conversationId:string;owner:string;organization:string;
  origin:string;originIdentity:Record<string,unknown>;expected:string;requestDigest:string;sessionId:string;sessionEvidenceReference:string;
  authorizationReference:string;instruction:string;quarantineDeliveryIds:string[];
  priorResult?:string;createdAt:number;paneId?:string;reportConfig?:string;
  resumePhase?:'reserved'|'waiting';
  status:'reserved'|'creating'|'starting'|'waiting'|'sending'|'accepted'|'uncertain'|'blocked';reason?:string;
}
class ContinuationBlocked extends Error {}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class LegacyContinuation {
  runtime:Runtime;
  roots:{codex:string;claude:string};
  constructor(runtime:Runtime,roots={codex:join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions'),claude:join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects')}){this.runtime=runtime;this.roots=roots;}
  verifySession(w:Worker,g:Pick<Continuation,'sessionId'|'sessionEvidenceReference'>):void{
    const root=realpathSync(w.kind==='claude'?this.roots.claude:this.roots.codex);
    const path=realpathSync(g.sessionEvidenceReference),rel=relative(root,path);
    if(rel.startsWith('..') || isAbsolute(rel))throw new ContinuationBlocked('Session evidence is outside the provider history root');
    const fd=openSync(path,'r');const bytes=Buffer.alloc(65536);let count=0;
    try{count=readSync(fd,bytes,0,bytes.length,0);}finally{closeSync(fd);}
    let matched=false;
    for(const line of bytes.subarray(0,count).toString('utf8').split('\n')){
      try{const e=JSON.parse(line);const m=w.kind==='claude'?e:e.type==='session_meta'?e.payload:undefined;
        if(m && (m.id??m.sessionId)===g.sessionId && typeof m.cwd==='string' && realpathSync(m.cwd)===realpathSync(w.worktree)){matched=true;break;}
      }catch{ /* Only matching structured metadata is evidence; never forward history text. */ }
    }
    if(!matched)throw new ContinuationBlocked('Exact saved session/worktree metadata could not be verified');
  }
  snapshot(w:Worker,c:Conversation){
    const deliveries=this.runtime.state.all<Delivery>('deliveries').filter(d=>d.workerId===w.id).map(d=>({id:d.id,status:d.status,digest:hash(d.text)}));
    const identity={workerId:w.id,conversationId:w.conversationId,owner:c.owner,organization:c.metadata.sokosumi_organization_id,generation:w.generation??0,paneId:w.paneId,taskId:w.taskId,worktree:w.worktree,repo:w.repo,branch:w.branch,kind:w.kind??'codex',hold:w.recoveryHold,holdId:w.holdId,resultDigest:hash(w.result??''),deliveries};
    return {digest:hash(identity),identity,quarantineDeliveryIds:deliveries.filter(d=>['queued','sending','uncertain'].includes(d.status)).map(d=>d.id).sort()};
  }
  context(job:Job,id:string){
    const r=this.runtime,w=r.state.get<Worker>('workers',id),c=r.state.get<Conversation>('conversations',job.conversationId);
    if(job.kind!=='chat' || r.job(job.id).status!=='in_progress' || !w || !c || !c.owner || !c.metadata.sokosumi_organization_id || w.conversationId!==c.id || !r.ownsWorker(job,w))throw new ContinuationBlocked('Exact active owner chat and organization required');
    return {w,c};
  }
  plan(job:Job,id:string){
    const {w,c}=this.context(job,id);const s=this.snapshot(w,c);
    const grant=this.runtime.state.get<Continuation>('legacyContinuations',id);
    if(grant && (grant.owner!==c.owner || grant.organization!==c.metadata.sokosumi_organization_id))throw new ContinuationBlocked('Continuation scope changed');
    return {workerId:id,expectedSnapshot:s.digest,generation:w.generation??0,paneId:w.paneId,taskId:w.taskId,approvalHold:Boolean(w.recoveryHold),legacyHold:!w.holdId,quarantineDeliveryIds:s.quarantineDeliveryIds,
      requirements:['Exact saved session ID with private provenance','Renewed owner authorization for independent read-only work','No live agent or non-shell process in retained pane','Historical actions remain unknown; no replay or approval'],
      continuation:grant?this.result(grant):undefined};
  }
  result(g:Continuation){return {workerId:g.workerId,key:g.key,status:g.status,reason:g.reason,paneId:g.paneId,historicalHoldRetained:true,quarantineDeliveryIds:g.quarantineDeliveryIds,accepted:g.status==='accepted'};}
  current(job:Job,g:Continuation){
    const {w,c}=this.context(job,g.workerId);
    if(c.owner!==g.owner || c.metadata.sokosumi_organization_id!==g.organization || this.snapshot(w,c).digest!==g.expected)throw new ContinuationBlocked('Continuation identity, ownership, hold or historical deliveries changed');
    return {w,c};
  }
  save(g:Continuation){this.runtime.state.put('legacyContinuations',g.workerId,g);}
  async run(job:Job,id:string,e:Record<string,unknown>){
    const r=this.runtime,{w,c}=this.context(job,id);
    const requestDigest=hash(e);let g=r.state.get<Continuation>('legacyContinuations',id);
    if(g){
      if(g.requestDigest!==requestDigest)throw new ContinuationBlocked('Existing continuation reservation differs; reconcile instead of replacing');
      if(g.owner!==c.owner || g.organization!==c.metadata.sokosumi_organization_id)throw new ContinuationBlocked('Continuation scope changed');
      if(['accepted','uncertain'].includes(g.status))return this.result(g);
      if(g.status==='blocked')g.status=g.resumePhase??'reserved';
      if(['creating','starting','sending'].includes(g.status)){
        g.status='uncertain';g.reason='Interrupted external operation; inspect outcome, no automatic replay';this.save(g);return this.result(g);
      }
      this.current(job,g);
    }else{
      const snapshot=this.snapshot(w,c);
      if(!w.recoveryHold || w.holdId || !w.taskId || !existsSync(w.worktree))throw new ContinuationBlocked('Existing legacy-held worker, assigned task and retained worktree required');
      if(e.expectedSnapshot!==snapshot.digest || e.readOnly!==true || e.noHistoricalReplay!==true || JSON.stringify(e.quarantineDeliveryIds)!==JSON.stringify(snapshot.quarantineDeliveryIds))throw new ContinuationBlocked('Exact snapshot, quarantine list and read-only/no-replay authorization required');
      if(snapshot.identity.deliveries.some(d=>d.status==='sending'))throw new ContinuationBlocked('An instruction is still in flight; do not branch around it');
      const sessionId=textField(e,'sessionId');
      if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId))throw new ContinuationBlocked('Exact saved session UUID required; never guess --last');
      const instruction=textField(e,'instruction');
      if(instruction.length>16000)throw new ContinuationBlocked('Bounded read-only instruction required');
      g={key:textField(e,'key'),workerId:id,conversationId:c.id,owner:c.owner,organization:c.metadata.sokosumi_organization_id!,origin:snapshot.digest,originIdentity:snapshot.identity,expected:snapshot.digest,requestDigest,sessionId,
        sessionEvidenceReference:textField(e,'sessionEvidenceReference'),authorizationReference:textField(e,'authorizationReference'),instruction,quarantineDeliveryIds:snapshot.quarantineDeliveryIds,priorResult:w.result,createdAt:Date.now(),status:'reserved'};
      if(g.key.length>120 || g.authorizationReference.length>1000 || g.sessionEvidenceReference.length>4096)throw new ContinuationBlocked('Bounded key and private evidence references required');
      this.save(g);
    }
    try{
      let current=this.current(job,g);
      this.verifySession(current.w,g);
      const task=record((await r.api(`/tasks/${encodeURIComponent(current.w.taskId!)}`,'GET',undefined,r.contextHeaders(current.c))).data);
      this.current(job,g);
      if(task.assigneeId!==r.config.coworkerId || (task.ownerId??task.userId)!==g.owner || task.organizationId!==g.organization)throw new ContinuationBlocked('Live task ownership/organization/assignment changed');
      if(g.status==='reserved'){
        const agents=await r.herdr.agents();current=this.current(job,g);
        if(agents.some(a=>a.pane_id===current.w.paneId || a.name===current.w.name || a.cwd===current.w.worktree))throw new ContinuationBlocked('A live retained session exists; inspect/resolve or explicitly close it without approving old actions before restricted restoration');
        const workspace=r.state.get<string>('meta','workspace');if(!workspace)throw new ContinuationBlocked('Owned workspace unavailable');
        const listing=await r.herdr.call(['pane','list','--workspace',workspace]);current=this.current(job,g);
        if(!Array.isArray(listing.panes))throw new ContinuationBlocked('Cannot verify pane absence');
        const pane=listing.panes.map(record).find(p=>p.pane_id===current.w.paneId);
        if(pane){
          const info=record(record(await r.herdr.call(['pane','process-info','--pane',current.w.paneId!])).process_info);current=this.current(job,g);
          const foreground=Array.isArray(info.foreground_processes)?info.foreground_processes.map(record):[];
          if(pane.cwd!==current.w.worktree || foreground.length!==1 || foreground[0].pid!==info.shell_pid)throw new ContinuationBlocked('Retained pane is not a verified idle shell; no replacement');
          g.paneId=current.w.paneId;
        }else{
          g.status='creating';this.save(g);
          const created=await r.herdr.call(['tab','create','--workspace',workspace,'--cwd',current.w.worktree,'--label',current.w.name,'--no-focus']);
          g.paneId=paneFrom(created);this.save(g);current=this.current(job,g);
        }
        r.state.transaction(()=>{
          current.w.paneId=g.paneId; // Keep old identity in the immutable origin snapshot; hold remains true.
          r.state.put('workers',id,current.w);g!.expected=this.snapshot(current.w,current.c).digest;g!.status='starting';this.save(g!);
        });
        // Restrict the resumed provider; never reuse a broad-permission live process.
        const args=current.w.kind==='claude' ? ['--resume',g.sessionId,'--permission-mode','plan'] : ['resume',g.sessionId,'-C',current.w.worktree,'--no-alt-screen','-s','read-only','-a','never'];
        await r.herdr.call(['agent','start',current.w.name,'--kind',current.w.kind??'codex','--pane',g.paneId!,'--',...args]);
        this.current(job,g);g.status='waiting';this.save(g);
      }
      const live=await r.workerAgent(this.current(job,g).w);current=this.current(job,g);
      if(!live || !['idle','done'].includes(live.agent_status)){
        g.reason='Restricted session is not verified idle/done; no prompt or approval keys sent';this.save(g);return this.result(g);
      }
      // Herdr also rejects a live approval/question dialog at the actual prompt boundary.
      const reportConfig=r.state.transaction(()=>{
        current.w.generation=(current.w.generation??0)+1;
        current.w.state='working';current.w.result=undefined; // Prior result remains in the immutable reservation.
        r.state.put('workers',id,current.w);
        const path=r.scopedConfig({kind:'worker',id,generation:current.w.generation});
        g!.reportConfig=path;g!.expected=this.snapshot(current.w,current.c).digest;g!.status='sending';this.save(g!);return path;
      });
      await r.herdr.prompt(g.paneId!,`This is a NEW, separately authorized READ-ONLY continuation of the same task and saved session. Historical approval and instruction outcomes remain UNKNOWN and quarantined. Do not retry old commands, execute pending tool calls, approve dialogs, send messages, create tasks/PRs, merge/deploy, or change external data. Reconcile observed existing state first. Use only the explicitly authorized read-only data copy after verifying provenance/freshness; no production fallback. If safe read-only access or provider restrictions prevent work, report that blocker.\n\nCurrent authorized scope:\n${g.instruction}\n\nReport only new observations as a partial/complete result accurately. Use the scoped worker-result command if permitted by the restricted provider; otherwise leave a concise structured result in this same pane for owner inspection. CODEPAT_CONFIG=${JSON.stringify(reportConfig)} node ${JSON.stringify(r.config.cliPath)} worker-result ${id} <result-text>. Never loosen sandbox/permissions to report.`);
      g.status='accepted';g.reason=undefined;this.save(g);return this.result(g);
    }catch(error){
      const external=['creating','starting','sending'].includes(g.status);
      g.resumePhase=g.status==='waiting'?'waiting':'reserved';
      g.status=external?'uncertain':'blocked';
      g.reason=external?'External outcome unconfirmed; retained without replay':error instanceof ContinuationBlocked?error.message:'Read-only continuation preflight failed; inspect session metadata and scoped access';
      this.save(g);return this.result(g);
    }
  }
}
