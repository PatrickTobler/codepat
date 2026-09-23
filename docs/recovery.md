# Chat deadlines, durable recovery and reboot preparation

This change is source only. It does not restart a service, reboot a host or deploy either contact/progress feature branch.

## Deadlines and failure evidence

`CODEPAT_CHAT_TIMEOUT_MS` and `CODEPAT_BACKGROUND_TIMEOUT_MS` each default to 3600000 (one hour). The former covers chat turns; the latter covers every non-chat turn, including task coordination, worker results and periodic review. These are elapsed execution deadlines, not token/context budgets or provider rate limits. Each accepts whole seconds from 60000 through 3600000 milliseconds. The bridge validates both at startup and explicitly passes them to the runner it launches in Herdr. Changing only the bridge environment does not change an already-running runner; use a drained rollout of both processes.

For every turn, systemd `RuntimeMaxSec` comes from its selected budget. `TimeoutStopSec` is five seconds and the JavaScript fallback is the same budget plus ten seconds, allowing systemd to terminate the process group first. At the default, all turns have `RuntimeMaxSec=3600`, `TimeoutStopSec=5` and a 3610000 ms watchdog. This is not a concurrency scheduler or context rewrite.

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
5. Verify loopback health, effective timeout in the new runner environment, job-scope denial for workers, monitor/poll errors, original worker IDs/panes/tasks, and a genuinely requested chat. Tests exercise deadlines without waiting an hour; production timeout/reboot acceptance remains unperformed.
6. Roll back only after draining the new runner. Preserve current state and receipts; do not restore an older database over new results. New optional fields are compatible with old JSON storage, but old binaries do not enforce generation fences and do not understand attempt-specific receipt names. Before downgrade, reconcile held jobs and retire old attempt credentials under authorized maintenance; retain new receipts for manual recovery. A blind binary downgrade while a recovery attempt is active is unsafe.

Tests use synthetic temporary state and local subprocesses. They cover killed processes, nonzero exit, systemd timeout versus watchdog, durable receipts/restart, old-runner claims, bounded same-ID recovery, partial output, lost acknowledgment, duplicate notification reservations, stale credentials/completions, ownership and approval/uncertain-delivery gates. No live systemd transient turn, production message, PR creation by a recovered agent or real reboot was used as a test. Existing worker/project/outbox tests continue to cover stable operation keys and ambiguous remote write reconciliation.

## Missing completed sessions

A completed worker can retain a saved result and stale pane after a host/session interruption without being marked archived. `read` returns saved evidence with `missing: true` rather than implying the parent task is done. A restricted continuation preserves the prior result in `priorResult` while the new generation runs, so evidence remains visible without treating it as the new completion. An explicitly authorized `resume` now checks the recorded pane is absent or an idle shell before restoring the same worker/worktree/session. A live unidentified process is a recovery block, not permission to duplicate it. Existing approval holds or sending/uncertain instructions return `status: recovery_blocked` with the held delivery IDs, without changing state or sending new instructions. Inspect the saved result/session and reconcile historical outcomes and the actual pending human decision first. This does not add an API for clearing uncertainty or approving unknown dialogs; a resume request alone is not evidence that old external actions did not occur.


## Codex/provider failures versus process deadlines

Codex exec emits top-level `error` and `turn.failed` JSONL events, as documented in the [official non-interactive guide](https://developers.openai.com/es-419/docs/non-interactive-mode). CodePat projects only those event envelopes into fixed diagnostic categories: provider safety restriction, authentication, usage/rate/context limit, connection failure or unknown provider failure. It never sends arbitrary error messages, response bodies, URLs, stderr, tool output or reasoning to users. Message-only exec errors use a narrow allowlist of known phrases; unknown errors remain explicitly unknown.

A terminal failure stays failed even if partial final text exists or a process exits zero. A transient `error` followed by successful completion does not turn success into failure. Systemd timeout, OOM or signal evidence takes precedence. The sanitized terminal category is fsynced in the attempt receipt and preserved through runner death; the completion stores its fixed code/text in the existing durable job. No new retry or external action is introduced.

Provider safety-policy rejection is not a timeout and is not evidence of host resource exhaustion. Resolve it through supported provider access/review channels where appropriate; do not automatically replay, rephrase to evade the restriction, switch credentials or weaken approvals. A generic nonzero exit without recognized protocol evidence remains an unknown process failure. Historic exact causes cannot always be recovered: inspect only the affected turn's authorized private session error metadata, never publish its transcript.

## Claude Code orchestrator fallback

When a Codex turn fails as usage limit, authentication, rate limit, connection or context limit *before emitting any item* (no command, tool call or message), the runner reruns the same prompt with `claude -p --output-format stream-json --permission-mode bypassPermissions` under the same `codepat-turn-<stem>.service` name, so the supervisor's liveness check and receipts still cover it. Codex policy rejections and failures after Codex acted never fall back: the first could route around a provider restriction, the second could repeat side effects.

Each conversation gets one deterministic Claude session (derived from the conversation ID, resumed with `--resume` once its session file exists); review and incident turns run with `--no-session-persistence`, matching their fresh Codex context. Claude does not see earlier Codex history and is told to read current state through the CLI. The receipt records `fallback: "claude"` and clears the Codex failure; the answer is written to the output file before `completed` is set, so ordinary recovery can deliver it. If Claude also fails, the job fails as `fallback_failed`. Codex stays primary and is tried first on every turn.

These diagnostics require a new pinned bridge/runner release after a natural drain. A previous deadline-only deployment does not activate this addition. Keep the one-hour settings and all worker/state identities; no active coordinator interruption is required or permitted.

### Worker instruction holds

A shared guard checks the current durable worker identity, approval/recovery hold and any sending/uncertain instruction before `send`, `resume`, session wake/launch, instruction reservation and prompt dispatch. It rechecks after asynchronous task/pane/session operations before further writes or dispatch. `send` is not a workaround for a blocked `resume`. A blocked control request returns `recovery_blocked` with an approval flag, unresolved delivery IDs and a fixed reason. This adds no hold-clearing or approval operation.

Queued instructions retain their IDs and text across recovery/restart. Held dispatches remain queued with `blockedReason`; an unattempted preflight failure is not marked as an uncertain send. Immediately before a real Herdr prompt, the bridge durably records `sending`; loss of that acknowledgment remains uncertain and blocks later instructions. Accepted prompts are not proof the agent acted or completed the task. Busy unheld workers still accept ordinary steering. A routine approval records its receipt only after the inspected dialog fingerprint and focused key are revalidated; it never grants a worker reporting credential approval authority.

Automatic recovery reuses an existing queued instruction instead of superseding it. A recovery preamble requires reconciliation before continuing. Pane/session preparation alone no longer emits a recovered notice or a RUNNING task event. The recovery notice is emitted only after Herdr acknowledges the prompt; lost acknowledgment produces no success notice. A hold arriving while a tab is being created retains the new pane reference without starting its agent; a hold arriving during an already-issued start prevents subsequent instructions and retains the hold. These guards cannot revoke an external call already issued before a new hold was observed.

Synthetic reproductions: `node --test src/worker-guard.test.ts src/reliability.test.ts src/recovery.test.ts`. They cover held idle/completed lifecycle gates, restart, uncertain sibling instructions, holds arriving during task/pane/prepare/start operations, ordinary steering and recovery acknowledgment loss. No real worker is resumed by these tests. Historical boolean-only holds without approval provenance and unresolved effects remain blocked. The narrow audited workflow below applies only to new holds with known action evidence.


### Audited owner-chat hold reconciliation

This workflow is source support, not deployment or permission to resolve any particular action. It runs only in an active chat for the exact owning conversation and organization. Worker reporting credentials and autonomous worker/review/incident jobs cannot invoke it. No approval keys, task transitions, prompts or session launches are sent by reconciliation.

1. `worker-hold <worker>` exposes the retained hold and routine receipts. `inspect-worker-hold <worker>` takes no evidence file and returns the exact action, action-text digest, raw dialog fingerprint, hold/pane/generation/session binding and supported selection. It checks the owned live dialog; inspection is **not authorization**. Unknown layouts and ambiguous terminal controls produce actionable conflicts, not a license to strip text or send keys.
2. `record-worker-hold <worker> --file /private/hold-action.json` repeats the inspected `actionText`, `dialogFingerprint`, `holdId`, `generation`, `paneId` and Claude `sessionId`, plus `actionDigest` and a real private `evidenceReference`. It binds the command and rereads the pane after owner/task checks. Existing differing evidence cannot be replaced; legacy boolean-only holds remain unknown.
3. For an exact already-authorized routine command, the active owner chat may call `worker-approve-routine <worker> --file /private/approval.json`. Repeat the binding and add `routine: true`, category `read-only`, `tests` or `dependency-install`, `key: "enter"`, and `authorizationReference` to the actual owner's authorization. Only a supported selected one-time Yes is accepted; persistent/global/auto choices, worker tokens and autonomous worker/review/incident authorization of this Claude flow are refused. No global auto mode or raw-key workaround is authorized.
4. An `accepted` routine receipt means key transport acknowledged, not command success or completed work. Inspect the same session's actual outcome and closed idle/done dialog. Then `reconcile-worker-hold <worker> --file /private/hold-decision.json` repeats the binding/action evidence and adds the actual `decision` and `decisionReference`. For an accepted routine decision use `routine:<receipt-id>`; for a real human action use its privately witnessed reference. A user's claimed approval with the original dialog still visible remains unresolved. A closed durable hold can still be reconciled from actual owner-attested action/decision evidence when its action was not recorded before closure; this never applies to a legacy boolean-only hold.
5. `sending` and `uncertain` key receipts never resend, including after restart. Reconciliation requires the exact `approvalReceiptId` and `keyOutcomeReference` from real inspection/human-action evidence, retaining the old uncertain receipt. Sending/uncertain worker instructions or conversation deliveries still prevent release. Denial/cancellation requires the exact queued instruction IDs in `retireDeliveryIds`; they are retired and the worker remains stopped. Conflicting decisions are rejected.

The main service renders these commands from `CODEPAT.md` into its private orchestrator `AGENTS.md`; do not patch the live file to bypass review. See [routine recovery acceptance](routine-recovery-acceptance.md) for the bounded Claude layout, explicit evidence, independent-review bootstrap, provider compare/send race and live acceptance matrix.

Action evidence file (synthetic values; take real binding fields from the scoped hold read):

```json
{
  "holdId": "observed-hold-id",
  "generation": 1,
  "paneId": "observed-pane-id",
  "actionDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "evidenceReference": "private-inspected-dialog-record"
}
```

Decision file repeats `holdId`, `generation`, `paneId`, `actionDigest`, and adds `decision` (`approved`, `denied` or `cancelled`) and `decisionReference`. For denial/cancellation also supply `retireDeliveryIds` containing every currently queued instruction ID, including an empty array when none exist. No decision changes an uncertain delivery.

These are authenticated owner-context **attestations**, not cryptographic verification of a human pressing a button. CodePat cannot independently establish the truth of a private evidence reference. The trusted orchestrator must inspect the exact action and preserve the human decision; it must not fabricate attestation or use generic revival authorization for an unknown approval. Where proof is unavailable, leave the hold blocked. No automatic monitor observation (including working) clears a hold.

### Review hardening and rollback limits

Dispatch generation/result changes and `sending` are committed in one SQLite transaction before the prompt. A crash rolls both back or leaves a sending receipt, which restart conservatively makes uncertain. A scoped reporting config may have been created on disk before a transaction rollback; its uncommitted scope grants no authority.

A follow-up may already have reopened a COMPLETED task before a new hold arrives; blocked responses expose `priorAcceptedTaskTransition` when known. No-instruction-dispatched does not mean no task transition occurred. An ambiguous transition response remains unconfirmed. Preparing automatic recovery of a READY task does not move its status to RUNNING; task lifecycle reporting remains a separate orchestrator step.

If worker identity changes during tab creation, the returned pane reference is retained in private `orphanWorkerPanes` metadata for inspection. It is not started, adopted or closed automatically. If the tab-create response itself is lost, its identity may be unknown; inspect Herdr before any replacement attempt. The bridge cannot revoke an external call already issued before a hold appeared.

Before downgrade, drain or safely retire new `incident` jobs and preserve all workerHolds, receipts, decisions and unresolved operations. An older runtime lacks these guards and can deliver queued held instructions: do NOT downgrade into runnable held queues or unresolved reconciliation state. Keep the service safely paused pending a compatible repair when those conditions cannot be met; never clear holds or restore stale SQLite to make rollback appear safe.

### Quarantined legacy read-only continuation

A historical boolean hold cannot be converted into a guessed old approval. A separate, one-use owner authorization can permit **new independent read-only inspection**, while retaining the original hold and every historical instruction status. This is a narrow exception for restoring the same missing worker, not a release of old actions or permission to use ordinary `send`/`resume`.

An active owner chat in the exact conversation/organization uses:

```sh
node src/cli.ts worker-continuation-plan <existing-worker-id>
node src/cli.ts continue-worker-readonly <existing-worker-id> --file /private/continuation.json
```

The plan returns `expectedSnapshot` and the exact sorted `quarantineDeliveryIds`. Supply those values in the authorization file:

```json
{
  "key": "independent-readonly-stage-1",
  "expectedSnapshot": "digest-from-scoped-plan",
  "quarantineDeliveryIds": ["exact-existing-unresolved-instruction-id"],
  "readOnly": true,
  "noHistoricalReplay": true,
  "authorizationReference": "reference-to-renewed-owner-instruction",
  "sessionId": "00000000-0000-4000-8000-000000000001",
  "sessionEvidenceReference": "/private/provider-history/exact-session.jsonl",
  "instruction": "Verify the approved read-only copy provenance and freshness first; inspect only the authorized data. No production fallback, writes, historical retries or messages. Report remaining limitations precisely."
}
```

Use the real saved session ID, never the example or a guessed `--last`. The runtime reads at most 64 KiB of the specified session history, under the runtime user's canonical `.codex/sessions` or `.claude/projects` root. It requires matching structured session ID and worktree metadata; transcript text is neither returned nor added to the prompt. Missing/mismatched metadata is a blocker. Preserve history and verify copy provenance; a database URL's presence does not prove an approved copy or read-only database role.

The operation verifies live task owner/organization/assignment and exact worker/task/worktree/branch/pane/generation, hold and delivery snapshot after awaits. A sending instruction still in flight prevents reservation. It refuses any live agent matching the retained pane, worker name or worktree, and any non-shell process in an existing pane. It never kills a session, answers a dialog, or uses a replacement worker/task. If the pane is absent, it creates only a replacement pane for the **same** worker/session identity. An existing verified idle shell may be reused.

Codex restoration uses the explicit session ID with `read-only` sandbox and `never` approvals; Claude uses the explicit ID with `plan` permission mode. These provider controls restrict local execution; they are **not proof of read-only remote database permissions or of every connected tool's behavior**. A safe database connection/read-only role or equivalent approved query path still has to be verified by the audit. Never weaken restrictions or use production fallback to make an audit or result report work. In particular, sandbox networking/reporting or plan-mode tools may be unavailable. The worker must report that limitation; the owner can inspect structured output through the existing scoped read operation if the reporting command is unavailable.

A new instruction is submitted only to the verified idle/done restricted session, with an explicit no-historical-replay preamble. Herdr also refuses a live blocked dialog at submission. Generation/reporting scope changes and the new sending receipt are atomic; the previous partial result, original identity snapshot and authorization are retained privately. The original `recoveryHold` remains true and old queued/uncertain instructions retain their IDs, text and statuses. Ordinary operations remain blocked. Acceptance means prompt submission acknowledged, not model execution, audited interactions, completed task or reconciled old outcomes.

Creation/start/send phases are durable. A lost external acknowledgment or restart during a phase becomes uncertain and is not retried; new reservations retain the exact ambiguous phase (`creating`, `starting`, or `sending`) for reconciliation. Older uncertain records without that marker remain phase-unknown and must not be guessed. A verified startup still waiting for input can be inspected; repeating the identical request in `waiting` rechecks readiness without relaunching. Never replace an uncertain reservation with a new key. This deliberately provides one continuation reservation per worker; further grants or an uncertain new reservation require separate audited reconciliation, not resetting its record. A preflight block may be retried with the identical evidence after its actual prerequisite is repaired, but changed snapshots or scope require inspection rather than replacing the reservation silently.

**Review gate bootstrap:** this source feature is not available in an older live bridge. Deploying the whole unreviewed PR to unblock its reviewer would bypass its gate. A live held reviewer is also ineligible for missing-session restoration. The coordinator must obtain genuine owner-led resolution of its current UI (or deliberate closure of that same session without approving unknown actions), retain its exact saved session, and arrange independent re-review under an explicitly agreed maintenance/recovery path. A human can interact with their existing agent directly; automation must not impersonate that decision or send a hidden bypass prompt. If neither a valid current UI decision nor a separately reviewed/authorized recovery path is available, report this gate dependency explicitly. Do not invent reviewer approval, claim re-review complete or launch a substitute worker.

### Known startup update notices

Herdr `blocked` alone does not distinguish approval, question and updater UI. Do not classify a historical hold from idle status or arbitrary terminal text. For an **unstarted Codex worker only** (generation zero, no result and no prior sent/uncertain/sending instruction), a witnessed update-menu **Skip** can be reconciled in an active owning chat:

```sh
node src/cli.ts worker-continuation-plan <existing-worker-id>
node src/cli.ts reconcile-startup-notice <existing-worker-id> --file /private/update-skip.json
```

The evidence file contains the plan's `expectedSnapshot`, `notice: "codex_update_available"`, `decision: "skip"`, `noCommandApproved: true`, and an `evidenceReference` to the actual inspected menu/skip. The runtime verifies the exact retained agent is idle/done before and after live task ownership checks, refuses a hold that already has a recorded command action, then atomically records the non-approval classification and releases only this known startup hold. It sends no keys, update/install command, prompt or task transition. This is an owner-context attestation, not automatic UI recognition. Unknown command dialogs and historical audit holds are refused.

Existing queued initial instructions are preserved; `queuedDeliveryIds` tells the coordinator to wait for those rather than replaying the prompt. If `resumeRequired` is true, use the existing scoped `resume <same-worker> --file <original-authorized-instructions>` once. If the worker already progressed to generation one/working, do not run reconciliation or resume: inspect actual progress and treat the old startup failure notification as stale. A known skipped updater does not authorize npm installation or any underlying command approval.

## Archived receipt and saved-session continuity

A same-owner-job archived resume retry returns its original queued/sent delivery only while its recorded task/conversation/pane/kind/session/hold, generation and recovery epoch still match. Retired/superseded, failed, unknown or legacy unbound receipts, later rearchive, changed generation/session/pane or stopped lifecycle return a 409 conflict identifying the receipt and delivery. The retry is never silently reinterpreted as new work. Reconcile the prior operation before separately authorizing a different instruction; do not delete the receipt.

Archived idle reuse requires reliable structured Herdr `agent` provider kind and `agent_session_id`, with the same retained session ID. Name, cwd and terminal title alone are insufficient. Active observations retain these bindings; known Codex/Claude saved sessions are relaunched with their exact ID instead of guessing the latest conversation. An unbound legacy record requires an active-owner `resume ... --recovery-evidence /private/session.json` containing the witnessed original `sessionId`, current `paneId` (omit if none), `generation` and private `evidenceReference`. This attests saved-session continuity, not a command decision; the reference is retained. Missing/mismatched live kind/session metadata stays blocked. It does not permit held/uncertain work, raw state edits or replacement workers.

Recovery writes merge only their intended fields into a freshly read, identity/lifecycle-fenced record. A worker result arriving while task/Herdr/startup calls await is retained, including its completed state. The live acceptance gate must still verify the installation's structured metadata and actual resumed output; synthetic adapter fixtures are not proof of provider integration.

### Review clarifications for retained recovery

- **Legacy archive acceptance (N4):** the retained `adee87bb-ff1e-49ab-bb0d-88d33806f96a` author may predate saved session binding. Before its authorized wake, the coordinator must witness the original provider conversation/session continuity and supply `--recovery-evidence /private/session.json` with that `sessionId`, current `generation`, private `evidenceReference`, and the current `paneId` when present. Omit `paneId` when absent; do not invent a pane or infer continuity from name/cwd alone. A queued delivery is not resumed work. Capture actual output in the same saved session and confirm no duplicate instruction. Missing evidence, holds and uncertain effects remain blockers.
- **Whole-capture controls (F4):** ambiguous control characters anywhere in captured output, including scrollback outside the command, intentionally refuse inspection. Never strip the capture into an approvable action. Literal tabs, multiline text and CRLF retain their documented semantics; unsupported captures need a reviewed provider/parser path.
- **Receipt meaning (N5):** a retry may return an already accepted one-time approval receipt even after the live session changes. It acknowledges only the prior key transport, sends no new key, and proves neither current session identity nor command success. Fresh hold inspection/reconciliation still checks current identity and refuses drift with 409. Do not use that receipt to claim continuation or release a changed-session hold.
- **Trust and privacy (N3/N6):** category labels are assertions by the authorized coordinator, not command safety classification. Exact action inspection and actual task authorization remain required; only the supported one-time Yes can be selected. Control output, exact commands, references and local diagnostics are private operational material, not public chat/PR content. Expected identity conflicts give safe actionable 409s; unexpected internal errors remain generic 500s without backend details. Persistent/auto-mode changes and uncertain replay remain forbidden.

Cleanup skips expected recovery conflicts per worker so one disabled/held/uncertain worker does not starve later eligible workers. A disabled Grok worker's pane, archive intent and history are retained; cleanup does not launch, resume, select or close it.

## Explicit new-session continuation for retained tasks

Use this when saved-session continuity cannot be established and the owner has authorized continuing the existing task from reconciled Git/PR/results. It is a **new provider session**, not a claim that the historical conversation was recovered. Worker/task/worktree/branch and prior results remain; no new worker or task is hired.

In the exact owner conversation run `fresh-worker-plan WORKER`. Reconcile its Git head/status and existing PRs/results, then prepare private JSON with a stable `key`, the plan's `expectedSnapshot` and sorted `quarantineDeliveryIds`, `newSession: true`, `noHistoricalReplay: true`, a bounded `instruction` describing only remaining authorized work, and real `authorizationReference` / `handoffReference`. Run `continue-worker-fresh WORKER --file /private/handoff.json`.

If the exact owned pane still contains an inspected idle/done provider, include `retireIdleSession: true` only as the explicit decision to end that session. The plan binds provider/pane/name/cwd and foreground process metadata; execution rechecks before closing that one pane. Busy, changed, ambiguous and held sessions are refused. A missing pane or verified shell can start fresh without retirement. No raw approval keys or fabricated SessionStart reports are used. As with Herdr approval, no atomic compare-and-close primitive exists: the coordinator must not concurrently manipulate the selected pane.

The durable receipt records the original worker/result, reconciled handoff, exact prior deliveries and each external stage. Old queued/uncertain instructions become `quarantined`, retain their prior status/text and link to that receipt; they never become sent/successful and are never delivered by the new session. In-flight instructions or uncertain task reports block the operation. Existing holds cannot be cleared or bypassed; canceled tasks are refused. Canceled audits and superseded reviews are not eligible targets under the current authorization.

The new session must report authentic native provider identity and become idle before a new instruction is queued. `waiting` means inspect startup/integration readiness and retry the same private request, not launch another session. The original owner grant can be continued by an exact claimed worker/task coordination event; an event cannot originate a new grant. Lost close/create/start acknowledgements retain uncertainty and prohibit automatic replay or a replacement key. Queued retries return the same receipt only while its delivery and lifecycle match. A deliberately new continuation uses a new stable key; old receipts remain audit records.

Generation advances at session replacement to revoke old worker reporting credentials, then once at actual instruction dispatch. The new instruction explicitly labels the new session and quarantined actions. Existing result reporting and task outbox handle result assessment and upstream updates; queued, transport-accepted, observed work and confirmed task update remain separate states. A prior result is handoff material, not proof the new instruction completed.

### Already-authorized routine coordination

A claimed coordinator `worker` event bound to the exact worker, task, owner and conversation can inspect/record an exact supported routine dialog, issue its one-time Yes with the existing task authorization reference, and reconcile only its exact accepted `routine:RECEIPT` after same-session dialog closure. It no longer needs a new chat solely because the provider uses the Claude layout. Category labels remain trusted coordinator assertions, not a semantic command classifier. Such events cannot invent human approval/denial evidence. Worker reporting credentials still authorize results only; periodic/incident scopes, other workers/tasks, persistent/global choices and uncertain keys remain denied. Actionable event scheduling remains the original blocked-event author's feature, not duplicated here.

### Live rollout and acceptance targets

PR10 adapter head `7f13173` was independently reviewed, merged and activated separately from this new-session implementation. Its authentic Codex SessionStart integration was installed with private backups; other Codex configuration was preserved. Installing the hook does not backfill retained `--last` agents. New-session/delegated-routine changes require independent review and exact-head checks before their own deployment.

After review, coordinator targets the retained adee, landing and kodosumi tasks, each with its existing brief and existing PR. Run plan, reconcile handoff and quarantine list, then execute once. Capture the fresh receipt, new native session ID, unchanged task/worktree/branch, one instruction receipt, actual work output, worker-result local acceptance, and task-report sent/upstream evidence. For adee explicitly retire only its inspected idle old pane if needed; do not infer a prior-session ID. Landing/kodosumi archived follow-ups can use absent-pane startup. A subsequent archive wake uses the newly bound saved session. Test an actually needed routine command through the original author's blocked-event flow; no manufactured commands, unknown approvals or paid calls. Unknown external outcomes stay quarantined and must not be declared resolved by new work.
