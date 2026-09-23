# Archived startup and hold inspection repair

An archived worker can retain `archivedAt` after Herdr starts its saved session but fails to acknowledge `agent start`. Previously `wakeWorker` always started another agent. Recovery now lists live agents before launching: exactly one idle/done agent must match the retained pane, worker name and worktree. Task ownership/assignment, local owner/organization, generation and recovery guards are rechecked. A retained pane without a verifiable agent, a duplicate name, another pane owner or a blocked/busy UI stops recovery for inspection. It never assumes a missing receipt means the launch failed. A fresh archived worker without a pane or named live agent still uses the existing saved-session launch path.

The worker, task, pane and generation remain unchanged when reusing the session. Normal instruction delivery advances the generation only when claiming its prompt. Concurrent control retries use the existing worker operation lock. Archived resume delivery and its receipt are committed atomically; identical retries in the same owner job/generation return that delivery across restart, even after it was sent. A new owner job is a new instruction, so the coordinator must reconcile existing deliveries before intentionally issuing it. Sending/uncertain instruction outcomes remain blocked. This change does not make Herdr startup or prompt delivery transactional, and it does not recover an unacknowledged tab creation with no known pane identity.

## Exact hold inspection

The supplied Claude Bash layout has a header, auto-mode tip, three-space `│ ` command gutter, separate description, approval notice and numbered options. The prior routine-approval parser rejected that layout; runtime errors were then hidden by HTTP as `500 Internal server error`. The regression uses synthetic paths and the described multiline shape, not a live pane capture.

In an active owner chat for the exact conversation, use the scoped CLI:

```sh
node src/cli.ts worker-hold WORKER_ID
node src/cli.ts inspect-worker-hold WORKER_ID
```

Inspection returns the exact `actionText`, its `actionTextDigest`, raw-pane `dialogFingerprint`, worker/pane/generation/hold binding and `routineApprovalSupported`. It verifies task ownership when a task exists and rereads the pane before returning. Keep output private: commands may contain sensitive arguments. Inspection neither records evidence nor supplies human authorization.

For `record-worker-hold`, the coordinator supplies the inspection's binding, exact action and fingerprint plus the independently established `actionDigest` and private `evidenceReference` in its evidence JSON. Recording rereads the complete dialog after task verification; a changed dialog or identity produces a safe HTTP 409. Recognized hold validation conflicts are exposed; unexpected internal errors stay generic 500. Worker tokens remain limited to results, and autonomous jobs cannot inspect/record/resolve owner holds.

The bounded parser now supports a complete owner-chat-only one-time routine decision flow with structured session binding, two dialog reads and durable non-replay receipts. See [routine recovery acceptance](routine-recovery-acceptance.md) for exact evidence fields, independent-review bootstrap and the live acceptance matrix. Supporting the layout does not itself authorize the command. Never turn inspection output into a guessed approval. Legacy boolean-only holds remain unchanged; inspection does not create a hold identity or action provenance. Use the separately documented owner-authorized read-only legacy continuation when applicable; ordinary resume remains blocked.

## Independent review handoff

Coordinator: arrange independent review of this focused branch. Do not replace held reviewers, revive canceled audits or superseded reviews, or assign this prerequisite worker the blocked-event feature. Its original worker retains that implementation. Review should specifically challenge lost startup acknowledgement, ambiguous live identities, restart/concurrent delivery receipts, changed-dialog checks, exact routine authorization and one-time selection, safe HTTP errors and preserved legacy/uncertain holds. No independent reviewer was launched by this worker.

Validation: Node 24.21.0 / npm 11.19.0, `npm ci --ignore-scripts`, `npm test` (244 passed), `npm run typecheck`, `node src/cli.ts --help`, `git diff --check`. Tests use temporary SQLite, synthetic Herdr/task data and local HTTP. No live pane, production state, decision, worker prompt or service was changed during validation.

## Deployment and rollback procedure (coordinator-owned; not executed)

1. Obtain independent approval of the exact commit and check the draft PR's CI. Resolve findings and rerun the checks before deployment. Patrick authorized deployment after validation/review; this handoff does not satisfy the independent review itself.
2. At a natural coordinator drain, record the current release and bridge/runner unit paths, worker/task/pane/generation bindings, pending deliveries and hold identities using authorized scoped inspection. Preserve private state with SQLite's backup API and existing private configuration/receipt backups. Do not copy secrets into review artifacts or alter worker worktrees.
3. Prepare a separate pinned release from the reviewed commit with Node 24.21.0 and locked dependencies. Validate it there. Gracefully switch bridge and its idle runner using the established service deployment procedure. Never run two bridges on the same database/socket, interrupt unrelated workers, or replace Herdr.
4. Verify loopback health, service errors and scope restrictions. In the original owner context, inspect the retained archived worker and resume only after checking pending deliveries and the live idle identity. Verify the same task/worker/pane, one queued/sent instruction and no duplicate agent/tab. Inspect the Claude hold through the new command; keep it held pending its actual decision. Do not clear any live hold as a deployment test.
5. If validation fails, stop further recovery/dispatch and drain the new bridge/runner. Preserve current SQLite and every new delivery, `archivedResumes` receipt and hold record. Prefer a reviewed forward fix. The previous binary does not understand archived-resume receipts or this inspection layout: do not replay resume after downgrade or permit runnable unresolved recovery queues. Switch to the recorded old release only when the coordinator can keep affected recovery operations paused and verify existing guards suffice. Never restore stale SQLite, delete receipts, clear holds or send keys to make rollback appear successful.

Remaining live acceptance: independent review, pinned release deployment and original-worker resumption by the coordinator. No credentials/services are required for offline validation; live rollout requires the existing authorized owner job and maintenance context.
