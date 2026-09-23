import assert from 'node:assert/strict';
import test from 'node:test';
import {availableWorkerKinds, configuredWorkerKinds} from './worker-kinds.ts';

test('installed Grok is neither probed nor advertised unless explicitly enabled', async()=>{
  const probed:string[]=[];
  const installed=async(kind:string)=>{probed.push(kind);return true;};
  assert.deepEqual(await availableWorkerKinds(configuredWorkerKinds(undefined),installed),['codex','claude']);
  assert.deepEqual(probed,['codex','claude']);
  assert.deepEqual(await availableWorkerKinds(configuredWorkerKinds(' codex, claude,codex '),installed),['codex','claude']);
  assert.deepEqual(await availableWorkerKinds(configuredWorkerKinds('grok'),installed),['grok']);
});
test('provider configuration rejects invalid lists and intersects installed binaries',async()=>{
  for(const value of ['', ' ', 'codex,', ',claude','unknown','CODEX','codex,unknown'])
    assert.throws(()=>configuredWorkerKinds(value),/CODEPAT_WORKER_KINDS/);
  assert.deepEqual(await availableWorkerKinds(configuredWorkerKinds('codex,claude'),async kind=>kind==='claude'),['claude']);
  assert.deepEqual(await availableWorkerKinds(configuredWorkerKinds(undefined),async()=>false),[]);
});
