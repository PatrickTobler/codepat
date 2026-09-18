# Chat deadlines, durable recovery and reboot preparation

This change is source only. It does not restart a service, reboot a host or deploy either contact/progress feature branch.

## Deadlines and failure evidence

`CODEPAT_CHAT_TIMEOUT_MS` defaults to 600000 (ten minutes). It accepts whole seconds from 60000 through 3600000 milliseconds. The bridge validates it at startup and explicitly passes it to the runner it launches in Herdr. Changing only the bridge environment does not change an already-running runner; use a drained rollout of both processes.

For chat turns, systemd `RuntimeMaxSec` comes from that budget. `TimeoutStopSec` is five seconds and the JavaScript fallback is the same budget plus ten seconds, allowing systemd to terminate the process group first. Task/worker notification turns retain their existing 180-second budget and 190-second watchdog. This is not a concurrency scheduler or context rewrite.

The runner no longer uses `--collect`, which could remove a failed transient unit before inspecting its result. After settling the process tree, it reads systemd's `Result`; only after persisting completion does it reset that failed unit. Timeout, confirmed `oom-kill`, signal/core dump, normal nonzero exit, interruption and empty successful output have distinct sanitized codes/text. A systemd timeout is recognized even when the JS watchdog never fired. Heavy swapping can make a host slow, but it is not evidence that every error was an OOM or timeout. Unknown systemd evidence stays unknown rather than inventing a resource diagnosis. Private stderr/error objects are not used as the user-facing failure explanation.

## Recovery boundaries

Each claim records a protocol version and attempt generation. The new runner obtains a durable `begin-turn` acknowledgment before spawning Codex. An ambiguous begin acknowledgment never causes a second spawn. It writes attempt-specific private receipts for the thread ID, `turn.completed`, and final reply. Receipt replacement fsyncs both the file and containing directory. SQLite retains final status/text and the operation/outbox records.

A replacement runner does not steal another runner's active job just because a heartbeat is stale: a swapped-out process may still be alive. The bridge first verifies that the tracked runner pane is an idle shell and the previous transient unit is inactive, failed or absent after reboot. If this proof is missing, it retains the claim and reports the blocked maintenance condition.

Once process death is established:

- A valid matching completion receipt is delivered to the same job. A confirmed `turn.completed` checkpoint plus final output can also recover completion. A partial output file alone does not prove success.
- Terminal jobs stay terminal, including after a lost completion acknowledgment. Retrying reply cannot reserve a second task update or chat delivery. Existing uncertain outbox items remain uncertain; this does not invent exactly-once remote delivery.
- A protocol-aware reservation that never authorized a spawn can be requeued under the same response/conversation ID, at most twice. Legacy claims cannot prove this and are held for reconciliation.
- A started but unconfirmed turn becomes a failed response with `recovery_required`, preserving its thread, workers, tasks and files. It is not blindly rerun. Arbitrary shell/network actions are not completely covered by CodePat's operation ledger, so automatic replay cannot safely promise no duplicate PR, task or message.
- Corrupt or wrong-attempt receipts fail closed with sanitized text and remain on disk for inspection. Receipts for different attempts have different filenames. Old attempt credentials and late completions cannot modify a recovered attempt.

After the user explicitly authorizes continuation and the coordinator verifies prior effects, it can use:

```sh
node /absolute/codepat/src/cli.ts recover-chat <failed-response-id> \
  --reconciled --file /absolute/private/reconciliation.md
```

This is an active-job scoped operation for a failed chat in the same conversation, not a worker reporting operation. The file must describe concrete checks: existing worker operation keys and task IDs; whether pending/uncertain deliveries committed; existing GitHub PRs for the retained branch; remaining authorized work and human approvals. The runtime rejects recorded uncertain/sending effects and limits total recovery attempts to two, including automatic reservation retries. It keeps the original input/idempotency key and job ID, adds the reconciliation note, resumes the saved Codex thread when available, and rotates the job credential generation. Do not claim that `--reconciled` itself verifies a remote action; that evidence must exist before invoking it. If uncertainty remains, leave the turn held.

The existing bounded missing-worker recovery keeps the same task, worker, worktree, branch and saved session. This change prevents it from superseding/replaying uncertain instructions and retains recorded human approval waits. It continues to verify pane identity and live task assignment before recovery. Its recovery prompt explicitly requires checking existing PRs and prior external actions. Such agent checks are not a transactional guarantee for arbitrary third-party tools. No approval dialog is accepted automatically.

## Observed boot chain and remaining gaps

Read-only host inspection during development found CodePat enabled as a user service, `Restart=on-failure`, and user lingering enabled. Its unit wants/starts after `network-online.target`, but has no Herdr dependency. The Herdr server was running; no Herdr user unit appeared in the inspected unit inventory. This establishes neither Herdr startup after a reboot nor pane/session restoration. No reboot or new service installation was performed.

With lingering, the user manager can start CodePat without an interactive login. The bridge then needs the intended Herdr socket/server before it can restore its workspace and runner. API health alone does not prove the agent chain is ready. If Herdr is unavailable, control/state remain durable and monitor/runner setup retries; it must not classify all missing workers as completed. Confirm the supported Herdr boot/session mechanism for the installed version separately rather than inventing or silently installing a service. Persist the intended HOME, socket path, credentials, Node/Codex binaries, repositories and private state. A restored pane ID alone is not identity proof; mismatched agent name/worktree remains blocked.

For a planned CPU upgrade/reboot, first stop accepting new work operationally, let the coordinator turn finish, and inspect busy/blocked workers and pending delivery outcomes. User approval of a reboot is separate from this implementation. Existing approvals do not become blanket permission to replay uncertain work after boot. After the authorized reboot, check Herdr/socket readiness, CodePat service/health, runner heartbeat, transient unit absence, SQLite/outbox state, each preserved worker identity and reporting generation. Unstarted reservations and saved replies recover automatically; uncertain started turns need the reconciliation workflow above.

## Review, rollout and rollback (not executed)

1. Review this independent draft PR against main. It does not include contact PR #2 or streaming PR #3. Any eventual integration conflicts should be resolved explicitly and retested; neither unrelated feature is authorized for deployment here.
2. Prepare a clean pinned release; run locked dependency install, tests and typecheck. Set the optional timeout in the private service environment. Validate bounds before rollout.
3. Drain the coordinator without killing it or interrupting unrelated workers. Back up SQLite using its backup API, private environment/unit/drop-ins, scopes, client configuration, orchestrator prompt, thread/output/completion receipts and worker/task mappings. Keep them private and out of Git. Record the old release and runtime/worker identities.
4. During separately authorized maintenance, stop the bridge's claim intake, confirm no active coordinator, and gracefully replace only its idle runner. Start the reviewed bridge and runner together: an old runner does not implement the new begin/receipt protocol or timeout setting. Preserve worker panes/processes, Herdr and all reporting scopes. Never force a busy pane to become a shell.
5. Verify loopback health, effective timeout in the new runner environment, job-scope denial for workers, monitor/poll errors, original worker IDs/panes/tasks, and a genuinely requested chat. Tests exercise deadlines without waiting ten real minutes; production timeout/reboot acceptance remains unperformed.
6. Roll back only after draining the new runner. Preserve current state and receipts; do not restore an older database over new results. New optional fields are compatible with old JSON storage, but old binaries do not enforce generation fences and do not understand attempt-specific receipt names. Before downgrade, reconcile held jobs and retire old attempt credentials under authorized maintenance; retain new receipts for manual recovery. A blind binary downgrade while a recovery attempt is active is unsafe.

Tests use synthetic temporary state and local subprocesses. They cover killed processes, nonzero exit, systemd timeout versus watchdog, durable receipts/restart, old-runner claims, bounded same-ID recovery, partial output, lost acknowledgment, duplicate notification reservations, stale credentials/completions, ownership and approval/uncertain-delivery gates. No live systemd transient turn, production message, PR creation by a recovered agent or real reboot was used as a test. Existing worker/project/outbox tests continue to cover stable operation keys and ambiguous remote write reconciliation.

## Missing completed sessions

A completed worker can retain a saved result and stale pane after a host/session interruption without being marked archived. `read` returns saved evidence with `missing: true` rather than implying the parent task is done. An explicitly authorized `resume` now checks the recorded pane is absent or an idle shell before restoring the same worker/worktree/session. A live unidentified process is a recovery block, not permission to duplicate it. Existing approval holds or sending/uncertain instructions return `status: recovery_blocked` with the held delivery IDs, without changing state or sending new instructions. Inspect the saved result/session and reconcile historical outcomes and the actual pending human decision first. This does not add an API for clearing uncertainty or approving unknown dialogs; a resume request alone is not evidence that old external actions did not occur.
