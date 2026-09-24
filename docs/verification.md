# Verification

## Automated

Run on Node.js 24:

```sh
npm ci
npm test
npm run typecheck
git diff --check
```

The suite covers:

- Conversation ownership, request idempotency and durable responses across restart.
- Streaming progress, reconnect cursors, terminal success and failure.
- Attachment size, host, redirect and file-type restrictions.
- One supervised coordinator turn at a time, durable claims and thread continuity.
- Bounded recovery of unstarted reservations without replaying a turn that may have executed.
- Codex-to-Claude fallback only before Codex acts.
- Task-event cursor persistence, event deduplication and self-authored event suppression.
- Scoped task status/reporting, owner/organization/assignment checks and report idempotency.
- Ambiguous task-event delivery reconciliation without blind replay.
- Read-only Herdr workspace and agent inventory for the active coordinator turn.
- Installed coordinator instructions require verified retirement of task-scoped Herdr agents without deleting worktrees or evidence.
- Project pagination, inspection and explicit owner-authenticated task reassignment.

The test suite uses local HTTP fixtures and temporary SQLite databases. It does not contact production services or exercise real credentials.

## Live acceptance

A release is not proven by unit tests alone. On the target host verify:

1. Herdr, Codex and optional Claude are authenticated under the service account.
2. `codepat.service` and the Herdr server remain active after logout.
3. `/health`, conversation creation, a streamed response and a follow-up in the same conversation succeed.
4. The coordinator can run ordinary shell/Git commands and directly use `herdr workspace`, `herdr pane` and `herdr agent` commands.
5. A Sokosumi task event creates exactly one coordinator turn and exactly one final task report.
6. Restarting the bridge while idle preserves conversation/thread continuity.
7. The deployed prompt contains no worker, hold, approval-dialog, periodic-review or archived-session workflow.

Keep private state, tokens, transcripts and task contents out of public verification artifacts.
