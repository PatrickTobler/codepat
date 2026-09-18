# One conversational contact and durable incident notices

The orchestrator assesses worker results and communicates with the requester. Infrastructure must not impersonate that assessment. This source change is not activated by publication; check the deployed release separately.

## Delivery paths

| Origin | Behavior |
| --- | --- |
| Worker result | Private worker record plus durable worker-review job; nothing is sent to the user until the orchestrator assesses it. Identical duplicate reports do not queue another job. |
| Worker blocked/missing/launch failure | Fixed scoped incident metadata; no raw error, prompt or transcript in the notification turn. |
| Worker restoration / authorized turn recovery | Recovery incident; restoration does not imply parent-task completion. |
| Runner/provider/receipt recovery failure | Sanitized failure code becomes a durable incident. Background errors no longer publish generic runner text directly. |
| Chat orchestrator fails | Response remains failed, with an explicitly labeled automated system notice; incident retained for explanation. |
| Explanation orchestrator fails | Failure retained on original incidents; at most one fallback if none was already issued. No recursive failure job. |
| Instruction, task/chat outbox or correlated native-send failure | Pending/failed/uncertain state is retained in scoped context. Original sends are not replayed. |
| Monitor/poll failure | Fixed availability incident for conversations with unfinished tracked workers; no host diagnostics broadcast. |
| Task lifecycle bookkeeping | Explicit automated system status. Orchestrator-authored FAILED/input/approval/external-wait reports get failure/blocked headings. Ordinary updates retain normal formatting. |
| HTTP error before a valid owned job exists | Protocol error, not an assistant answer. No guessed owner/conversation. A completely unavailable bridge cannot write incidents or deliver notices until recovery. |

Markdown headings in message content provide compatibility without undocumented Sokosumi UI metadata or a new parser. Existing SSE `response.failed` remains failure; it is not converted into success. Browser rendering remains a deployment check.

## Queue, scope and bounds

Incidents bind conversation, owner and organization at creation. Their stable ID hashes that scope and source identity. Duplicate events/restarts retain the same record. Claim and delivery revalidate scope; another user, organization or conversation cannot report the incident. Worker credentials remain reporting-only. Unknown legacy organization does not get an automatic notification turn.

The existing runner queue schedules at most one pending/running incident turn per conversation after active work finishes. User chats win; incident notices precede other queued background work. A batch has at most ten incidents; ordinary/review context rotates through at most twenty with total counts, so unchanged notices do not permanently hide later incidents. A five-minute per-conversation cooldown prevents catch-up bursts. Each incident gets at most one autonomous explanation attempt. If it fails, it remains visible to later ordinary turns; this never retries the underlying operation. Continuous chats can delay background delivery but receive pending incident context. The configured background deadline remains one hour by default.

The notification turn can only return an explanation and safe progress/thread bookkeeping. It cannot start, resume, recover-chat, task-report or send contacts. An ordinary authorized turn can use:

```sh
node src/cli.ts incident-report <incident-id> --kind failure --file /absolute/private/explanation.md
```

Kinds: `failure`, `blocked`, `recovered`. This checks exact conversation ownership and is idempotent once reported. It does not resolve task state, clear approvals or prove delivery. Automatic `[NO_UPDATE]` records assessment without sending, not completion. Worker and observer failures deduplicate by durable outage episode, not permanently by state. SQLite stores an active flag and monotonic sequence per conversation/owner/organization and observer or worker. Repeated unhealthy observations and restart during an outage reuse the existing incident, including its reviewed/attempt/delivery state. A fresh successful monitor or task-poll cycle closes only that observer's episode; absence of an in-memory error after restart is not proof of health. A verified healthy worker observation or explicit verified restoration closes that worker's episode only when no recovery hold or blocked state remains. A later failure creates a new incident eligible for one explanation under the existing cooldown. Restoration notices correlate to the episode as well, including when generation does not change. Health stamps `episodeEndedAt` but does not mark incidents reviewed, acknowledge delivery, grant approvals or replay work. If health occurred only during unobserved downtime, CodePat conservatively retains the same outage until a successful observation. Unresolved or undelivered notices remain in context.

A notice prefers the originating room; otherwise it stays on its linked task. Missing destinations remain observable as `notificationMissing`, never guessed. Correlation IDs retain pending/sending/sent/uncertain/failed states (`sent` means accepted by API, not read). Failed notice delivery cannot create another incident job. Uncertain sends are never blindly retried; historical HTTP422 entries are not repaired or replayed. Historical outbox entries without a verified conversation remain unassigned rather than leaked across users. Older native sends without conversation correlation are not assigned to a guessed conversation; their existing owner-scoped status tools remain available.

## Examples

Before: `The turn exited unsuccessfully.`

After orchestrator assessment:

> **CodePat — Failure update**
>
> The provider blocked the coordinator turn under its safety policy. Existing work remains tracked. No operation was retried; provider access/review is needed before attempting that work again.
>
> Task link

When the orchestrator cannot run:

> **Automated system notice — orchestrator unavailable**
>
> Codex reported a provider safety-policy restriction. The incident is retained for the orchestrator; no action was retried.

For a restored session:

> **CodePat — Recovery update**
>
> The existing worker session is restored. Its task is unfinished; the next step is to verify the required review.
>
> Task link

Ordinary update: `The change is ready for review.`

## Activation and rollback

Review the exact PR head; run locked install, tests and typecheck in a pinned immutable release. Back up private SQLite using its backup API plus config/scopes/receipts. Let the coordinator finish naturally; stop intake and verify no active turn before replacing only the idle runner and bridge. Preserve one-hour limits, worker panes and durable identities. Verify health, scoped incident context, queue/cooldown state and ordinary chat before claiming live behavior. No real-person error injection or uncertain-send replay is needed.

This adds JSON records and the `incident` job kind, without a destructive database migration. Before rollback, let incident jobs drain or use a reviewed maintenance path to retire their reservations. Do not hand queued incident jobs to an old binary that lacks notification-only restrictions. Retain incidents/outbox/receipts and latest state; never restore a stale database. Unknown outcomes, human approvals and provider restrictions remain separate prerequisites.
