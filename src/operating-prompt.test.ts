import assert from 'node:assert/strict';
import test from 'node:test';
import {renderOperatingPrompt} from './operating-prompt.ts';

test('installed coordinator instructions expose exact scoped inspect/record/approve/reconcile flow',()=>{
  const cli='/synthetic/release/src/cli.ts',prompt=renderOperatingPrompt(cli);
  for(const action of ['worker-hold','inspect-worker-hold','record-worker-hold','worker-approve-routine','reconcile-worker-hold'])
    assert.ok(prompt.includes(`node ${cli} ${action} <worker>`),action);
  assert.ok(!prompt.includes('{{CLI}}'));
  for(const constraint of ['Inspection is evidence, not authorization','accepted routine receipt acknowledges key transport, not command success','Legacy boolean-only holds','sending/uncertain','active owner chat','--recovery-evidence'])assert.ok(prompt.includes(constraint),constraint);
});
