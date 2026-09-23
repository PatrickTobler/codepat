import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Herdr,providerSessionId} from './herdr.ts';
import {Runtime} from './runtime.ts';
import {State,type Worker} from './state.ts';
const native=(agent='codex',value='saved-session')=>({agent,agent_session:{source:`herdr:${agent}`,agent,kind:'id',value}});
test('Herdr native session references normalize only matching supported provider IDs',()=>{
  for(const agent of ['codex','claude','grok'])assert.equal(providerSessionId(native(agent)),'saved-session');
  assert.equal(providerSessionId({agent_session_id:'flat-session'}),'flat-session');
  assert.equal(providerSessionId({...native(),agent_session_id:'saved-session'}),'saved-session');
  for(const item of [
    {agent:'codex'}, {...native(),agent:'claude'}, {...native(),agent_session_id:'different'},
    ...[{},[],5,'saved-session',{source:'plugin',agent:'codex',kind:'id',value:'saved-session'},
      {source:'herdr:codex',agent:'codex',kind:'path',value:'/saved'},
      {source:'herdr:codex',agent:'codex',kind:'id',value:'misleading\rsession'}].map(agent_session=>({agent:'codex',agent_session,agent_session_id:'flat-session'})),
  ])assert.equal(providerSessionId(item),undefined);
});
test('actual nested Herdr list shape reaches archive recovery; absent, changed and untrusted identities send nothing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'herdr-session-'));writeFileSync(join(dir,'client.json'),JSON.stringify({url:'http://unused.invalid',token:'synthetic'}));
  const state=new State(join(dir,'state.sqlite'));t.after(()=>{state.close();rmSync(dir,{recursive:true,force:true});});
  const h=new Herdr();let agent:Record<string,unknown>=native();let effects=0;
  h.call=async args=>{if(args.join(' ')==='agent list')return {agents:[{pane_id:'pane',name:'worker',cwd:dir,agent_status:'idle',interactive_ready:true,...agent}]};effects++;throw new Error('unexpected effect');};
  const runtime=new Runtime(state,h,{dataDir:dir,cliPath:'cli',repo:dir,apiUrl:'http://unused.invalid'});
  const c=runtime.createConversation('owner',{sokosumi_organization_id:'org'});
  const w:Worker={id:'worker',name:'worker',kind:'codex',conversationId:c.id,repo:dir,worktree:dir,branch:'b',prompt:'work',paneId:'pane',sessionId:'saved-session',state:'stopped',generation:48,archivedAt:1,createdAt:0,observedAt:0};
  for(const bad of [{agent:'codex'},native('codex','changed-session'),{...native(),agent_session:{source:'untrusted',agent:'codex',kind:'id',value:'saved-session'}}]){
    state.put('workers',w.id,w);agent=bad;
    await assert.rejects(runtime.wakeWorker({...w}),{status:409});
    assert.equal(state.get<Worker>('workers',w.id)!.archivedAt,1);assert.equal(effects,0);
  }
  state.put('workers',w.id,w);agent=native();await runtime.wakeWorker({...w});
  const after=state.get<Worker>('workers',w.id)!;assert.equal(after.archivedAt,undefined);assert.equal(after.sessionId,w.sessionId);assert.equal(after.paneId,w.paneId);assert.equal(after.generation,48);assert.equal(effects,0);assert.equal(state.all('deliveries').length,0);
});
