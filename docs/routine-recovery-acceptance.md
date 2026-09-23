# Routine recovery: review and live acceptance

This is a coordinator-run procedure, not evidence of deployment. Automated evidence uses temporary SQLite, synthetic task/Herdr responses and a reproduction of the reported Claude command `npm ci --ignore-scripts 2>&1 | tail -5`. No live held session was read, approved or resumed by the repair worker.

## Exact routine decision flow

Herdr 0.9.0's bundled API schema (protocol 22) exposes agent session metadata and `agent.send_keys`, but no structured permission decision or atomic fingerprint-conditional key operation. CodePat therefore parses a bounded Claude layout: one Bash command header, the known auto-mode tip, three-space `│ ` command gutters, one unboxed description, the approval notice, one proceed prompt, and four numbered choices. Only exactly selected choice **1. Yes** is eligible. Choices 2/3 (persistent and auto mode), No, multiple selections/dialogs and unknown boundaries are refused. Command newlines, pipes and interior whitespace are preserved. A narrow runtime operation sends one Enter only after authorization and all checks; this is not a generic raw-key workaround.

In the active chat for the exact owning conversation, the coordinator performs:

```sh
node src/cli.ts worker-hold WORKER
node src/cli.ts inspect-worker-hold WORKER
node src/cli.ts record-worker-hold WORKER --file /private/action.json
node src/cli.ts worker-approve-routine WORKER --file /private/approval.json
```

Use the existing owner job scope, never a worker token or copied master credentials. Inspection needs no evidence argument. It returns `holdId`, `generation`, `paneId`, `sessionId`, exact `actionText`, `actionTextDigest`, `dialogFingerprint` and `routineApprovalSupported`. Keep raw command/evidence output private. A supported layout is not by itself authorization or proof of a available session binding.

`action.json` repeats the inspection binding, text and fingerprint, and includes `actionDigest` (the digest of the privately inspected exact request, normally the returned action-text digest) and `evidenceReference`. Preserve existing recorded evidence; do not overwrite a different action. `approval.json` repeats that binding and adds `routine: true`, `category` (`read-only`, `tests` or `dependency-install`), `key: "enter"`, and `authorizationReference` to the actual owner's authorization of this exact routine operation. The category/reference are trusted coordinator attestations, not a semantic safety classifier. Consequential/out-of-scope commands require a human decision and cannot be relabeled as routine.

Approval rechecks task assignment/owner, local owner/organization, active job/generation, task/worker/name/worktree/kind, hold, pane, structured session ID, exact action and raw-pane fingerprint. A second read checks the dialog immediately before a transactional `sending` reservation; a changed record or concurrent reservation refuses the effect. The deployed receipt key is retained so an older uncertain receipt cannot be bypassed by a new key format. Accepted transport receipts survive restart and return without resending. `sending` or `uncertain` receipts never replay automatically. Worker reporting, periodic and incident scopes cannot approve; this new Claude flow additionally refuses autonomous worker-event authorization.

After the command finishes, inspect the **same** session and actual command outcome. The hold remains until its dialog is closed and the session is idle/done. An idle classification with a still-visible proceed dialog is refused. Then:

```sh
node src/cli.ts reconcile-worker-hold WORKER --file /private/decision.json
```

The decision file repeats the hold/session/generation/pane/action binding and evidence reference. For an accepted routine receipt, use `decision: "approved"` and `decisionReference: "routine:RECEIPT_ID"`; the runtime verifies that exact accepted receipt against the hold/session. This records an already-authorized one-time decision, not command success. For a real human action, reference the privately witnessed exact decision instead. A claim that approval happened while the original UI remains blocked is not execution evidence. For a lost key acknowledgement, supply the exact `approvalReceiptId` and a bounded `keyOutcomeReference` to real inspected outcome/human-action evidence as well; the original uncertain receipt stays uncertain and non-replayable. Never substitute a guessed routine receipt. Legacy boolean-only holds are not converted or cleared.

Expected approval/evidence conflicts return actionable HTTP 409 errors. Unknown layouts require a private current unwrapped capture and a reviewed parser fixture, not global auto mode or ad-hoc key input.

## Independent-review bootstrap (before deploying this code)

The coordinator now reports that a real user action closed the reviewer's setup dialog, subsequent output showed npm success and source/test work, and that reviewer completed its review of the old `b2b43eb` head. The user also enabled provider auto mode; CodePat did not do so, and this is not acceptance evidence for this patch's one-time flow. The durable hold still needs owner-scoped reconciliation. Keep the same reviewer/task/session and obtain re-review of the complete final head; the old review does not approve later code. This patch cannot bootstrap its own approval.

1. The coordinator records the current exact command, session, hold and visible choice. Check whether a real one-time human decision has actually closed it. Prior chat assent alone does not establish that.
2. A designated authorized human operator uses the **existing Claude permission UI** on the retained session to choose the inspected one-time Yes (or No if that is the actual decision). Do not use the unreviewed CLI, a raw-key script, auto mode, or clear the hold to get review running. This one-off bootstrap requires an available human/provider UI path; if none exists, independent review remains blocked and rollout must wait. It is not claimed to be automated. Patrick need not open a terminal if an authorized operator handles this initial UI action, but operator availability is a real prerequisite.
3. The coordinator verifies dialog closure, same session and actual command outcome, then uses the **already deployed** owner-scoped `reconcile-worker-hold` with witnessed action/decision evidence. Its existing closed-dialog path accepts exact action evidence for a durable hold even when prior recording was unsupported. It cannot reconcile while still blocked. Preserve uncertain instruction effects. Let that same reviewer continue its existing review, with the updated head relayed through CodePat only after safe reconciliation.
4. Review the complete PR head, including session adapter, parser/receipt races, error behavior and Grok restriction. Only after independent approval and CI should the coordinator deploy the reviewed pinned release, preserving `CODEPAT_WORKER_KINDS=codex,claude`, using the natural drain/backup/rollback procedure in `worker-recovery-repair.md`.

The terminal-free routine-setup acceptance below applies **after** final-head re-review and reviewed activation. The reported manual progress is coordinator evidence, not a live observation by this repair worker or a demonstration of the new routine path. Do not reproduce or toggle the user's auto-mode choice as a test.

## Acceptance matrix

All live cells below are pending coordinator execution. Capture timestamps, release SHA, task/worker/job IDs, session/pane/generation, receipt IDs and private evidence references. Do not paste credentials or sensitive pane text into reports.

| Journey | Synthetic evidence | Coordinator live acceptance and captured proof |
| --- | --- | --- |
| Start | Existing stable-operation and worker-kind tests; disallowed Grok fails before task/worktree/pane creation | Inspect advertised Codex/Claude. Reuse existing authorized workers/keys; no new worker is authorized by this repair. Record existing task/worker/worktree binding. Any separate fresh-start acceptance needs its own task authorization. |
| Routine setup | Current Claude `npm ci` fixture; exact text/session/pane/hold/fingerprint and second-read checks | After review/deployment, use the next genuinely needed already-authorized setup command in an existing eligible worker. Inspect, record and approve selected one-time Yes under active owner scope. No Patrick terminal action. Capture accepted receipt, subsequent working output, and actual setup completion/exit evidence. The current `... | tail -5` pipeline's exit status alone is not proof `npm ci` succeeded. |
| Blocked notification | Existing monitor/incident tests remain green | Capture the retained hold and coordinator notice receipt. Automatic actionable blocked-event implementation remains with its original author; it is a separate integration gate, not implemented here. No notice means escalation remains pending, not silent success. |
| Owner decision | Persistent/global choices refused; no keys on scope/session/dialog changes; uncertain keys held | Capture actual owner authorization and accepted one-time routine receipt, or a real human decision. Still-visible old UI means decision execution unconfirmed. Reconcile only exact supported evidence after closure. |
| Same-session continuation | Closure and same-session reconciliation, human-action and uncertain-outcome tests | Existing eligible held reviewer continues only after its supported exact decision reconciliation. Record unchanged worker/task/session/pane and continuing output. A queued prompt is not resumed work; avoid sending a new prompt when the original review is already progressing. |
| Archive wake | Lost-start acknowledgement/reopened-state/concurrent-retry regression | Inspect stopped archived author `adee` and pending/uncertain deliveries first. Resume through owner scope only when the retained saved session is verified idle. Capture same worker/task/session/pane, one delivery ID, one normal generation advance at dispatch, no additional agent/tab/start, and actual resumed output. A compatible same-operation retry returns its delivery; retired or later-lifecycle receipts return a conflict without waking or resending. Unbound legacy session continuity requires owner `--recovery-evidence`, never guessed `--last`. New-job retries require explicit prior-delivery reconciliation. |
| Worker result / task report | Existing result transaction and task-report/outbox reconciliation tests | Capture `worker-result` acceptance (local persistence only). Coordinator reviews result and uses the original task's `task-report` stable content/status. Capture `notificationId`, then poll the same report receipt until `status: sent` with HTTP/reconciliation evidence and verify the actual upstream event/task state. `pending`/`sending` is queued/in flight, not API acceptance; `uncertain` must be reconciled, never reposted blindly. |
| Service interruption / restart | SQLite reopen, accepted/sending/uncertain key receipts, concurrent runtimes and archived prompt tests | During authorized maintenance at a natural drain, record release/identity/receipts before and after one bridge/idle-runner restart. Keep Herdr and workers running. Confirm same sessions and no additional delivery/key effects. Do not deliberately lose an acknowledgement or kill the live reviewer; fault injection is synthetic. |

Suggested private evidence row: `{stage, releaseSha, observedAt, workerId, taskId, paneId, sessionId, generationBefore, generationAfter, deliveryId, approvalReceiptId, notificationId, transportStatus, apiHttpStatus, outcomeEvidenceReference}`. Mark each row **synthetic passed**, **live queued**, **live transport acknowledged**, **live work observed**, or **live API acceptance verified**. These are distinct claims.

## Remaining limits and rollback

Herdr offers no compare-and-send decision primitive; double inspection and the runtime lock minimize but cannot eliminate an external actor changing the UI between the final read and Enter. Do not concurrently manipulate a pane being approved. Missing structured session metadata, changed/persistent selections, unknown dialog variants, a new dialog appearing before the prior hold can be reconciled, or legacy provenance remain explicit holds. This patch does not bypass them to claim universal automation. Real Claude/Herdr integration, notification-to-owner orchestration and end-to-end upstream task delivery must pass the live matrix before claiming the whole journey works now.

Preserve all new hold session/fingerprint fields and routine receipts on rollback. Older binaries do not enforce these bindings or the Grok allowlist: pause affected approval/recovery/hiring paths, preserve the current database and prefer a reviewed forward fix. Never downgrade and replay an old receipt, restore stale state, or clear a live hold to make rollback appear successful.

### Final-head review findings

The review of `b2b43eb` predates the routine flow and Grok restriction. F1 is covered by a real CLI → authenticated HTTP → runtime regression with no evidence argument. The operating template now renders the inspect/record/approve/reconcile instructions (F2). Resume receipts reject retirement/failure/rearchive/generation/epoch drift (F3), ambiguous terminal controls are refused without stripping (F4), recovery merges fresh result state (F5), and archived reuse checks structured kind plus saved-session binding (F6). The actual-pane/parser and residual UI compare/send checks remain a coordinator live gate (F7). The reviewer's temporary probes were deleted; the repository contains newly recreated durable regression tests, not claims that those deleted probes were rerun.

### Bounded re-review corrections

N1 adds actionable 409 identity conflicts across actual CLI/HTTP inspect, record and reconcile paths, with unchanged holds and zero keys; unexpected internal errors stay private. N2 isolates expected cleanup recovery refusals and tests that a later eligible Codex pane actually closes while the disabled Grok worker is unchanged. Reviewer artifacts were read only; durable fixed-behavior regressions replace the old 500/starvation assertions.

For retained `adee` acceptance, provide witnessed `--recovery-evidence` if its legacy archive lacks a session binding: original `sessionId`, current `generation`, private continuity `evidenceReference`, current `paneId` if present (omit when absent). Verify retained-session work after dispatch, not just a queued receipt. See recovery's review clarifications for whole-capture control refusal, private control output, trusted coordinator category assertions and prior-transport-only accepted receipts after session drift. F7 real-pane acceptance remains pending; these synthetic checks do not prove live continuation. The same Claude reviewer must reconcile the final bounded correction before coordinator activation.
