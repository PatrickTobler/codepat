# Verification evidence

This standalone extraction was checked on 2026-09-17 with Node 24.21.0 and npm 11.19.0 on Linux. Checks run from this repository, without importing runtime code or dependencies from the source monorepo:

- `npm ci --ignore-scripts`: clean locked dependency installation; zero reported vulnerabilities.
- `npm test`: 81 passed, 0 failed, 0 skipped. Tests use temporary SQLite databases, local HTTP fixtures, synthetic identities and temporary Git repositories.
- `npm run typecheck`: passed.
- `node src/cli.ts --help`: passed without service/config/credentials.
- `git diff --check` and staged content/path review: no whitespace errors or private runtime artifacts. Only source, tests, documentation, license, package metadata and example configs are included.

The imported tests exercise conversation/idempotency isolation, scoped credentials, HTTP/SSE behavior, attachment limits, task polling, durable delivery/uncertainty, monitor concurrency, worker recovery, supported worker kinds, cleanup/restoration and Git worktrees. New project tests cover pagination across pages, repeated/missing cursor failures, access/status failures, active-job context binding, worker-scope denial, ownership and organization boundaries, explicit project validation before reservation, existing-task preservation, upstream dropped project IDs, recovery confirmation, owner reassignment and ambiguous write reconciliation. A local HTTP fixture verifies bounded read retries and no automatic PATCH replay.

Read-only live verification retrieved the docs root and v1 OpenAPI. Project list/detail, task create `projectId`, task PATCH `projectId`, pagination and context-header contracts were inspected. Core source was also read to establish owner-only PATCH authentication. A read-only project-control probe using the supplied worker reporting scope returned 401. No authenticated project inventory was obtained and neither requested existing task was reassigned.

Not tested end-to-end in this delivery: fresh Herdr installation, new agent account authentication, vendor/coworker registration, workspace grants, owner-authenticated production PATCH, DNS/TLS/authenticated ingress, systemd installation/restart, live task creation/worker launch or cleanup against Herdr. Installed tool versions were observed, but new workers/tasks were not launched. No live service configuration, source checkout, production database or unrelated session was modified. No rollout, restart, merge or deployment was performed.

The GitHub workflow repeats the source checks on Node 24.21.0; consult the actual PR checks for hosted-run status. Local checks do not prove infrastructure provisioning or upstream account permissions. Follow the disposable-host acceptance steps in setup before rollout.

The chat-recovery extension adds twelve tests for configurable deadlines, distinct systemd failure evidence, killed/nonzero subprocesses, durable completion/ack recovery, reserved versus started claims, bounded retry generations, unchanged operation/outbox identity, cross-conversation/worker-scope denial and uncertain-instruction/approval holds. Boot prerequisites were inspected read-only; no live deployment, reboot or real external-effect replay was tested. See [recovery](recovery.md).

## Periodic orchestration review

Local validation of the periodic-review change: locked `npm ci --ignore-scripts`, `npm test` (101 passed, zero failures/skips), `npm run typecheck`, CLI help and `git diff --check`. Tests ran with disk-backed `TMPDIR` because the host tmpfs quota was full. Twenty new synthetic tests cover twenty-minute boundaries/disablement, durable restart deduplication, no catch-up burst, foreground priority and active overlap, no-op silence, owner/organization/conversation isolation, scope identity changes, credential denial, approval/uncertain/queued-send holds, safe same-worker continuation, completed stage versus parent completion, bounded context and repeated-notification suppression. No live periodic AI turn, production message or deployment was performed.
