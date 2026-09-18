# Native Sokosumi contact tools

The CLI and runtime can find an organization member and send a native Sokosumi Direct as the configured coworker. Sokosumi is the primary channel for requested contact and proactive routine coordination within already-authorized work when that requester has enabled the standing preference. There is no email fallback; obtain explicit user direction before using another channel.

These are source capabilities. Publishing/merging the code does not activate them in an existing service. The running host must separately receive the reviewed code and private directory configuration during an authorized rollout. Worker-result credentials remain reporting-only and cannot invoke contact tools.

## Standing coordination preference

A requester can authorize CodePat to contact collaborators when relevant and reasonably necessary to complete work already authorized, without a separate explicit send instruction each time. Record this standing preference as `taskCoordination: true` on that requester's exact user/organization entry in the private contact registry during authorized setup. It defaults to false for other users; do not infer organization-wide permission. No new confirmation is needed for ordinary task coordination after this preference is established.

Appropriate examples: ask the verified reviewer for a required review, clarify a dependency with the known responsible collaborator, or share a relevant result with a participant. Clarify an ambiguous recipient, unrelated outreach, disclosure beyond the authorized task, or a consequential new promise about spending, scope, deadlines, merges or deployment. The preference does not grant additional task authority. Workers still have reporting-only credentials and route coordination needs through the orchestrator.

For proactive contact, add `--coordination "Request the already-required review of this task"` to `dm-send`. This bounded purpose is part of the durable send identity, cannot change under the same key, and is not sent as an API identity claim. The coordinator context exposes `contactPolicy.taskCoordination`. The runtime validates the private preference before queueing and again before delivery, so revocation stops queued proactive sends. Direct user-requested messages retain their existing command. Do not label proactive contact as a direct request to evade the preference. The coordinator is responsible for assessing relevance and commitments; a rationale string is an audit record, not machine proof of authorization or an OS sandbox.

## Coordinator commands

Use these inside an active coordinator turn, with the job-scoped `CODEPAT_CONFIG` and `CODEPAT_JOB_ID` supplied by the runner:

```sh
node /absolute/codepat/src/cli.ts contacts "Example Person"
node /absolute/codepat/src/cli.ts contacts "person@example.invalid"
node /absolute/codepat/src/cli.ts dm-send share-repository-once \
  --recipient <verified-user-id> --file /absolute/private/message.md
node /absolute/codepat/src/cli.ts dm-status share-repository-once
```

`contacts` matches names by case-insensitive substring and emails by case-insensitive exact match. It returns only matching user ID, name and email, not roles, presence or unrelated members. It reads the complete authorized organization directory before resolving ambiguity. The current endpoint is unpaginated; explicit cursor pagination is also supported, with cycle/malformed/incomplete-response checks. Duplicate IDs with conflicting identity metadata abort the lookup.

`dm-send` accepts exactly one of `--recipient <id>` or `--to "<name-or-email>"`. IDs are revalidated against the requesting organization's directory; they are not trusted merely because the model supplied them. Names/emails must resolve to exactly one person. No match or ambiguous matches result in a failed operation before room creation/message posting. Run lookup first and clarify ambiguous people before sending.

The normal path creates or returns the Direct for that recipient and CodePat. Its response must identify the intended organization, kind `direct`, exactly one human (the verified recipient), exactly one coworker (the configured sender), and no Soko Bots. No message is sent to a mismatched roster. Optional `--room <uuid>` instead reads that exact room with the requesting user's credential and applies the same checks. A user may not be allowed to read another person's private coworker DM; 403 is reported, not bypassed. The create-or-get path can verify the returned roster without using a coworker room-history read.

The control operations are `contacts` (query), `dm-send` (key, query or recipientId, optional roomId, text, optional coordination purpose), `dm-status` (key), and `dm-retry` (key). All require the active job ID. User and organization are derived from the stored conversation; identity, credential, API URL and configuration-path overrides are rejected. These are fixed operations, not an arbitrary HTTP proxy. The rendered `CODEPAT.md` operating prompt instructs the coordinator to use them and distinguish confirmed creation from delivery/read receipts.

## Private user-directory configuration

Sokosumi's organization-member directory requires user authentication. The coworker key is used only for create-or-get and send. Configure directory access separately for each actual requesting user and organization; never supply a vendor/admin credential to impersonate a requester.

1. Outside the checkout, prepare a private owner-account JSON using the existing `deploy/owner-config.example.json` format. Set `userId`, `organizationId`, `token` (that user's supported user credential), and `apiUrl`. `organizationSlug` remains useful for the existing task-project command but is not used to impersonate directory context. The API URL must match the service's configured API URL.
2. Prepare a private registry using `deploy/contact-accounts.example.json`. Each entry maps the exact user ID + organization ID to an absolute owner-account file path. Exactly one entry must match a request. Set `taskCoordination: true` only for a requester who has established the standing coordination preference; the example leaves it false.
3. Both registry and account files must belong to the service Unix user and have no group/other permissions (`chmod 600`). They must contain no real credentials in Git. Point `CODEPAT_CONTACT_ACCOUNTS_FILE` at the registry in the private service environment.
4. The runtime calls `GET /users/me` with the selected user credential and requires that its authenticated ID matches the requester. It then reads only the named organization's member directory and verifies the requester is a member. Agent keys are rejected for this configuration. All returned member organizations must match. Failed or missing credentials stop discovery and sends.

Keep `CODEPAT_API_KEY` as the dedicated `coworker_` key and `CODEPAT_COWORKER_ID` as CodePat's ID. They remain inside the configured service. No new credential is returned to model processes or written into send records. HTTP redirects cannot forward these credentials, and upstream error bodies are not echoed. HTTPS is required, except for loopback HTTP used by local tests.

As elsewhere in CodePat, these controls are routing/authorization safeguards within a trusted host. Model processes sharing the Unix account are not an OS secret-isolation boundary. Stronger isolation is required for untrusted users. See [operations](operations.md).

## Durable states and retries

Each send has a durable UUID (also submitted as `clientMessageId`) and a stable caller key scoped by user + organization, across jobs and restarts. Reusing that key with changed content or selectors fails. Keep the same key for the same intended message. The original recipient ID is pinned after resolution; a retry cannot silently switch to a new person whose name now matches.

| State | Meaning/action |
| --- | --- |
| `queued` | Durable intent saved; no acceptance claim. The background delivery loop processes it. |
| `sending` | Another operation is currently resolving/creating/posting; query status instead of creating a duplicate. |
| `accepted` | API response confirmed message ID, room, content and coworker sender. This is not proof of notification delivery or reading. |
| `failed` | No message was attempted, or the API returned a known rejection (400/401/403/404/422/429). Repair the cause and use `dm-retry` explicitly. |
| `uncertain` | A message POST may have committed: network loss, 5xx, 409, malformed success or interruption after message intent. Never replay automatically. |

The original `dm-send` attempts delivery synchronously after saving intent; concurrent/repeated calls return the existing record. A two-second service loop also handles queued work after disconnects or restart. Reads/status do not trigger duplicate posting. `dm-retry <key>` only requeues a safely failed operation and preserves its UUID; it does not retry accepted/uncertain operations. There is no automatic HTTP retry, including for 429. On startup, interrupted directory/room operations return to queued; interrupted message attempts become uncertain. Run only one bridge process against a data directory, as required by the existing runtime.

The room endpoint has create-or-get semantics for the same pair, so a lost room response can be retried before any message attempt. A successful room response is checked before recording message intent. That intent is persisted before the message POST. If the message outcome is uncertain, authorized recipient/operator inspection is required; coworker history is unavailable and this implementation does not scrape messages, force-reset uncertainty or invent an acceptance receipt. Do not switch to a new key to circumvent uncertainty. A corrected selector needs a new operation only after confirming the prior operation safely failed without message acceptance.

Recent send keys/statuses for the same user and organization are included in subsequent coordinator `directMessages` context, so it can recover a lost CLI response. `dm-status` remains the direct source of truth. State is private SQLite data containing recipient/message content and must be protected/backed up, never committed.

## Live API verification and contract gaps

Checked the [live API reference](https://api.sokosumi.com/) and [v1 OpenAPI](https://api.sokosumi.com/v1/openapi.json) during implementation on 2026-09-17:

- `GET /organizations/{id}/members` lists current-member directory metadata; the inspected Core source uses owner-user authentication. `GET /users/me` binds the credential to the actual requester.
- `POST /chats/rooms` explicitly supports a coworker key creating/getting an org-scoped coworker 1:1 using `{kind:"direct",memberUserIds:[id]}`, returning 200/201 with room roster. The actor supplies the coworker identity; no arbitrary coworker ID is sent in the body.
- The live room-create parameter list only advertises `X-Organization-Slug`. The inspected middleware/handler establishes coworker organization context from `X-Context-User-Id` and `X-Context-Organization-Id`, with membership validation. CodePat sends the actual requester context; it does not assume slug alone selects a coworker context.
- `POST /chats/rooms/{id}/messages` permits member coworkers to post as themselves and returns a created message. The live schema documents unique `(roomId, clientMessageId)` deduplication. The inspected local source implements this in the human-user branch, but its coworker branch returns earlier without persisting that field. This is a schema/source discrepancy, not proof of the deployed implementation. CodePat sends its stable ID but never relies on upstream deduplication to replay an uncertain coworker message.
- Room list/detail/history handlers in the inspected source require user authentication. The native coworker create-or-get response avoids relying on those for normal roster verification.

Automated tests use temporary state, synthetic identities, local HTTP servers and mocked APIs. They do not establish production account permissions or delivery to a real recipient. No live native message was sent as part of this implementation.

## Activation and acceptance plan (not performed by this change)

After reviewing the draft PR, obtain separate merge/rollout authorization. Deploy the reviewed commit to the designated service checkout without overwriting other work. Provision the private registry and the actual requesting user's owner account with verified organization membership, retain the dedicated coworker key, and confirm CodePat's workspace access. Follow the existing maintenance procedure to settle the coordinator turn and restart only the authorized CodePat service/runner; do not restart Herdr or unrelated workers. Source publication alone leaves the current service unchanged.

The new runtime renders the updated `CODEPAT.md` into its coordinator directory. In a fresh active requester turn, run `contacts` for the intended recipient, verify identity and organization, write the task-relevant authorized text to a private file, add `--coordination` for proactive routine coordination under the standing preference, and call `dm-send` once with a stable key. Record its message/room IDs only if `accepted`; query the same key after a lost response. A queued/sending/uncertain result is not completion. Verify any notification/reading independently rather than claiming it from HTTP creation.

Rollback only during authorized maintenance: preserve state and config, stop the new bridge, and restore the previous reviewed code. Keep uncertain send records for inspection; do not delete them to retry a send. Removing the registry disables new directory operations but does not erase history. No live config or running checkout is changed by these instructions.

## Existing task-report 422

A coordinator reported an earlier task-event POST returning 422. The live task-event schema accepts the usual reporting statuses, so HTTP 422 alone does not establish an invalid enum. Source has several 422 paths, including a committed OUT_OF_CREDITS pause with an error response. The original request/response were not available to this worker; the exact cause is unconfirmed. The existing outbox treats 422 as failed rather than automatically replaying it. This feature does not resend that event or change reporting behavior. Inspect its authorized request, response `kind`/message and event history before attempting a corrected report.
