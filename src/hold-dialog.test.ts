import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectHoldDialog} from './hold-dialog.ts';
import {recognizedDialog} from './routine-approval.ts';
const dialog = 'Bash command\nTip: auto mode handles these prompts for you\n   │ printf "a  b\n   │   c" |\n   │ head\n\n   Inspect worktree state\nThis command requires approval\nDo you want to proceed?\n❯ 1. Yes\n  2. Always allow\n  3. Allow session\n  4. No';
test('gutter parser preserves command whitespace and recognizes only one-time selection',()=>{
  assert.deepEqual(inspectHoldDialog(dialog),{action:'printf "a  b\n  c" |\nhead'});
  assert.deepEqual(recognizedDialog(dialog),{action:'printf "a  b\n  c" |\nhead',selected:'yes'});
  assert.deepEqual(inspectHoldDialog(dialog.replace('   │ head','   │ \n   │ head')),{action:'printf "a  b\n  c" |\n\nhead'});
  for(const malformed of [dialog.replace('   │ head','  │ head'),dialog.replace('   Inspect','unexpected\n   Inspect'),dialog+'\nDo you want to proceed?',dialog.replace('This command requires approval','unknown footer'),dialog+'\nAction: hidden'])
    assert.equal(inspectHoldDialog(malformed),undefined);
});
