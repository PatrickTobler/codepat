import assert from 'node:assert/strict';
import test from 'node:test';
import {renderOperatingPrompt} from './operating-prompt.ts';

test('installed coordinator instructions direct trusted Herdr operation with the small scoped surface', () => {
  const cli = '/synthetic/release/src/cli.ts', prompt = renderOperatingPrompt(cli);
  assert.ok(!prompt.includes('{{CLI}}'));
  for (const tool of ['instances', 'repositories', 'projects', 'project <uuid>', 'task-create --distinct', 'task-continue <task-id>', 'task-status [task-id]', 'task-upload --file <path>', 'task-report <STATUS>', 'task-runtime'])
    assert.ok(prompt.includes(`node ${cli} ${tool}`), tool);
  for (const direction of ['herdr --skill', 'full host access', 'danger-full-access', 'never in prompts or results'])
    assert.ok(prompt.includes(direction), direction);
  for (const lifecycle of [
    'Never answer dialogs in unrelated panes',
    'Resolve routine, non-consequential startup handshakes autonomously',
    'installed, user-owned Herdr session-reporting hook',
    'An `idle` label alone is not proof that startup completed',
    'Task-scoped agents are temporary',
    'stop the task-scoped agent',
    'close only the panes, tabs, or workspaces you created for that task',
    'Never delete a repository, worktree, branch, file, or evidence artifact as terminal cleanup',
    'Never present a local filesystem path as a user-facing link',
    'Never use `task-create` as a workaround',
    'Create a separate task only for a genuinely distinct deliverable',
  ]) assert.ok(prompt.includes(lifecycle), lifecycle);
  assert.ok(!prompt.includes("Do not parse or answer another session's interactive dialogs"));
  for (const removed of ['worker-hold', 'worker-approve-routine', 'recover-chat', 'dm-send', 'incident-report', 'review-work', `${cli} start`, `${cli} send`])
    assert.ok(!prompt.includes(removed), `${removed} must be gone`);
});
