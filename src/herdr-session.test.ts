import assert from 'node:assert/strict';
import test from 'node:test';
import {providerSessionId} from './herdr.ts';
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
