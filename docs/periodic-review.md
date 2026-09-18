# Periodic orchestration review

This feature is source only until its PR is merged and a separately authorized rollout installs it. It does not alter the deployed service, Herdr or other feature branches.

## Scheduling and configuration

`CODEPAT_REVIEW_INTERVAL_MS` defaults to `1200000` (20 minutes). Set `0` to disable, or an integer from 60000 to 86400000 milliseconds. Invalid settings fail startup. Changing the setting requires a bridge restart during an authorized drain. The first deadline for a newly observed scope is one interval after observation. An existing durable deadline remains after restart; a new setting governs subsequent deadlines. Disabling also retires already queued, unclaimed reviews silently; it does not interrupt an active turn.

The existing ten-second supervisor tick calls the scheduler; no new polling agent, process or sleep loop is installed. The three-second worker monitor remains separate. Each actual review is a durable AI job with normal claim, begin, receipt, scope and recovery semantics. User chat takes priority, then foreground task/worker events, then reviews. An active turn is never preempted or overlapped. This can delay review beyond twenty minutes during sustained foreground work; it is intentionally not a hard real-time deadline.

SQLite transactions retain per-conversation owner/organization identity, next deadline and sequence. There is at most one queued/running review per scope. Downtime produces at most one due review per eligible scope, not one for each missed interval. A worker that remains stuck can be reviewed every interval even without another state-change event. Restart does not require a second task or worker. Unconfirmed interrupted AI turns are not blindly replayed.

## What qualifies

Eligibility is restricted to the exact originating conversation with a known owner and organization. It includes unfinished workers, unresolved queued/sending/uncertain instructions, pending/uncertain/failed notifications and explicitly recorded pending stages. Stopped workers, old completed workers and open PRs alone are not authorization. Known completed/canceled/failed/reassigned parents are excluded from worker-stage eligibility; unresolved delivery evidence remains inspectable. Unknown legacy organization scope is skipped rather than guessed.

New worker results create a durable pending assessment. The orchestrator must verify evidence and record remaining authorization:

```sh
node /absolute/codepat/src/cli.ts review-work <existing-worker-id> --state pending --file /private/remaining-review.md
node /absolute/codepat/src/cli.ts review-work <existing-worker-id> --state waiting --file /private/approval-needed.md
node /absolute/codepat/src/cli.ts review-work <existing-worker-id> --state done --file /private/verified-complete.md
node /absolute/codepat/src/cli.ts review-status
```

These commands require an active scoped orchestrator job in the same conversation; worker reporting credentials remain reporting-only. `pending` describes remaining already-authorized steps, `waiting` records a user/external decision, `done` closes verified work. A completed implementation stage with a required review remains pending under its original worker/task. Pending or waiting stages prevent reporting the parent COMPLETED. Historical completed workers are not retroactively assigned invented obligations. Seed a historical remaining stage only during an authorized user turn with concrete evidence. New explicit follow-ups retain the worker identity and reopen its stage after normal ownership/assignment checks.

Periodic mutation additionally validates live task owner/organization and RUNNING/READY status, refuses stopped/blocked/busy workers, approval holds, waiting/done stages, already queued instructions, and sending/uncertain effects. Busy workers can be inspected and escalated without another instruction being appended. Reviews cannot reopen waiting/done stages, create tasks/workers, post task status transitions or approve interrupted-chat recovery. These are bridge-tool restrictions, not an OS sandbox: the trusted-host orchestrator can use shell tools and must preserve the same human authorization boundaries there. Do not share the host with mutually untrusted users.

## Silence, cost and visibility

Review turns start fresh instead of resuming or overwriting the user's chat thread. Initial context rotates through at most 20 worker summaries, 20 instruction records and 20 delivery records, with total counts. Notes are truncated to 500 characters in initial context; raw prompts/results/transcripts are excluded. The orchestrator can deliberately inspect owned detail using existing scoped tools. The usual non-chat three-minute systemd budget and 190-second watchdog apply. This limits duration/initial context, not model token spending or the number of eligible conversations.

The exact response `[NO_UPDATE]`, empty output and failed review turns produce no notification. New concise final updates are capped at 4000 characters and pass through the durable outbox. An evidence fingerprint suppresses another final notification for unchanged evidence even if the AI paraphrases it, including across restart. Monitor timestamp churn and review-generated notifications do not create new fingerprints or notification feedback loops. A changed evidence snapshot can justify an update; this is not semantic deduplication of arbitrary shell/API messages. No uncertain send is blindly retried by this feature.

Final updates use the original room route or an explicitly mapped task conversation. Without either destination they remain in the durable job record; do not invent destinations or fall back to email. Status reports interval/enablement, per-scope next deadline, pending review and latest terminal status/error. Operator `status` exposes interval/enablement without requiring coordinator credentials. Periodic failures are observable there through scoped review-status, not noisy repeated chat errors.

## Validation and activation

Tests use synthetic fixtures, SQLite reopen and fake scheduling timestamps. Run with a disk-backed TMPDIR if the host's tmpfs quota is exhausted:

```sh
mkdir -p "$HOME/.local/share/codepat-validation/tmp"
TMPDIR="$HOME/.local/share/codepat-validation/tmp" npm test
npm run typecheck
git diff --check
```

After review and separate merge/deploy authorization: pin the merged revision, perform locked installation and checks, privately back up SQLite using its backup API plus config/scopes/receipts, naturally drain the coordinator, and replace bridge/runner together following [recovery.md](recovery.md). Set `CODEPAT_REVIEW_INTERVAL_MS=1200000` or leave the default. Verify actual revision/health/monitor/heartbeat, inspect `review-status` through an authorized conversation, and observe the next genuinely eligible review after twenty minutes. No synthetic production tasks or external sends are needed. If rolling back, drain first and preserve current SQLite/receipts; old binaries do not understand queued review jobs, so do not downgrade while they remain queued/running. Disable and let the new runtime retire queued reviews first. Do not restore stale state over new work.

No live twenty-minute model turn, notification delivery, restart, deployment or reboot is exercised by these tests. Herdr reboot/session restoration remains a separate unverified prerequisite.
