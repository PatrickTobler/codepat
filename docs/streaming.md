# Live progress streaming

CodePat forwards safe coordinator progress from Codex JSONL through a job-scoped control operation into durable SQLite state, then to the requesting chat's SSE connection before completion. Progress uses Sokosumi's existing summary/activity display; the final answer remains separate. This is event-level progress, not simulated token streaming of a finished answer. Task/worker notifications and nonstreaming final responses keep their existing behavior. Worker panes are not scraped or broadcast.

## Event selection and transport

`src/progress.ts` projects an explicit allowlist:

- Assistant messages explicitly marked `commentary` are public progress; `final_answer` is excluded. The inspected Codex exec 0.154.0 contract omits phase. Its last unmarked assistant message is held until another assistant message or a recognized tool event establishes that work continued. The final held message is discarded from progress and delivered only through the existing output-file/reply path. A last commentary message followed only by completion may therefore not appear as progress.
- Command execution, file changes, MCP calls, web search and plan events generate fixed activity labels. Commands, arguments, paths, tool names, output, search queries, terminal transcripts and error payloads are never copied into those labels.
- Reasoning summaries are enabled only when `codex --version` exactly matches the inspected `codex-cli 0.154.0`. In that version, the JSONL emitter explicitly builds `ReasoningItem.text` from `ThreadItem::Reasoning.summary`, not raw reasoning. Unknown versions expose no reasoning text. Raw reasoning/analysis/delta events and unknown item types are ignored; an opaque event is never interpreted as a safe summary. Review the versioned emitter before extending this allowlist.

Only projected public text reaches the private journal and `/control/progress`. The runtime requires the active job credential and matching job ID. Worker reporting credentials are denied, and caller-supplied user/conversation/organization overrides are rejected. These controls retain the existing trusted-host model: an agent with the same Unix account is not isolated from host files. Public assistant text/summaries still depend on the model honoring instructions not to reveal secrets; fixed tool labels do not contain tool data.

The runner atomically journals each accepted projected item, attempts a bounded-time flush every 200 ms, and flushes before final reply. Failed acknowledgments retry the same keys. Each item key is idempotent; different content under the same key is rejected. The bridge recovers the journal before settling an interrupted turn, without launching replacement work for that response. Already persisted progress remains readable across runner or bridge disconnects. Invalid recovery journals are retained for operator inspection; completion can still report the interrupted turn.

A job retains at most 128 items, each at most 1,000 characters. Later progress is omitted once full, while the final answer is unaffected. This also bounds each control batch below the HTTP body limit, including JSON escapes. Raw event payloads are not journaled. The existing private job/state retention policy applies; successful normal completion removes the runner journal, while interrupted recovery files remain for inspection. Keep backups private. A reader that cannot drain within five seconds loses its SSE connection, not its durable job. No unbounded per-reader event queue is maintained.

## Wire format and replay

The stream emits:

1. `response.created`, stable event ID `<response-id>:0`.
2. For each durable progress item, `response.reasoning_summary_text.delta` followed by `response.output_item.done` (reasoning/summary item). Stable item IDs are `progress_<response-id>_<index>`; event IDs and `sequence_number` are monotonically ordered. Commentary, summaries and fixed tool activity use this supported UI container; the extra `progress_kind` field identifies their origin for consumers that support it.
3. The final `response.output_text.delta` with the actual final answer, then `response.completed` or `response.failed` and `[DONE]`. Completed output includes summary items separately from the final assistant message. Nonstreaming JSON keeps final text only.

`GET /v1/responses/<response-id>?stream=true` attaches to an existing response without creating work. Send `Last-Event-ID: <response-id>:<sequence>` to request only subsequent frames. A different response ID, malformed or future cursor is rejected. Owner and configured organization checks apply before stream access. Trusted authenticated ingress remains required; identity headers alone are not cryptographic authentication.

`POST /v1/responses` with `stream:true` also supports replay when the original `Idempotency-Key`, conversation and input are retained. A cursor-bearing POST without an idempotency key is rejected. Reusing the same key returns the existing job, never dispatches another. Without a retained response ID or original idempotency key, the server cannot distinguish a deliberate new identical request from a reconnect; do not blindly repeat POST. Disconnecting a stream cancels only that reader. Cursor-aware clients must retain their applied item state and event cursor; a new viewer without prior state can request the full stream.

## Verified Sokosumi compatibility and bounded follow-up proposal

Read-only inspection of the current Sokosumi checkout established:

- `packages/ai-provider/src/stream/responses-sse-to-v4-stream.ts` recognizes summary delta and reasoning item-done events. It emits AI SDK `reasoning-start`, `reasoning-delta`, `reasoning-end` separately from `text-delta` and suppresses duplicate full-text summaries on item completion.
- `apps/core/src/services/chat-room-mention-stream.ts` consumes reasoning deltas while the answer is pending and calls its thought-update callback. The chat-room message row renders live activity and retains a collapsible trace. The UI currently labels this container as thinking/thoughts; CodePat sends only the public content described above.
- The parser ignores SSE `id:` fields, and the inspected coworker request builder does not itself establish a durable idempotency key or automatic cursor reconnect. It also lacks explicit `response.failed` handling. The bridge emits accurate failure events and final error text, but current consumer classification may finish normally on `[DONE]` rather than mark the turn failed.

No Sokosumi source change is needed for live progress on a connected request. For automatic end-to-end reconnect and accurate failure classification, propose a separate bounded Sokosumi change: derive an idempotency key from the existing dispatch identity; retain response ID and last applied event ID; reconnect using the same authorized GET destination; deduplicate ordered frames while preserving accumulated item state; map `response.failed` to an AI SDK error and failed mention state. Add parser/dispatch tests for mid-summary and post-final reconnect, cross-owner rejection and failure after progress. Do not transparently retry a new POST after losing a connection. This PR does not modify that shared checkout or claim those consumer capabilities are deployed.

A read-only probe against the actual parser observed `response-metadata → reasoning-start → reasoning-delta → reasoning-end` before completion was supplied, then `text-start → text-delta → text-end → finish`. The synthetic progress appeared once. Reproduce against a separate Sokosumi checkout with its installed `tsx`:

```sh
/absolute/sokosumi/node_modules/.bin/tsx scripts/verify-sokosumi-stream.ts \
  /absolute/sokosumi/packages/ai-provider/src/stream/responses-sse-to-v4-stream.ts
```

Standalone integration tests exercise real loopback HTTP with the runtime, projector and journal, including observing SSE while the job remains `in_progress`, reconnect cursor replay, duplicate ingestion, private-event exclusion, owner/org/job isolation, worker-token denial, persisted state, bounded storage, terminal failure and nonstreaming/idempotency regression. No live model invocation, browser session, production ingress or deployed Sokosumi delivery was tested.

Protocol references: [official Codex noninteractive documentation](https://learn.chatgpt.com/docs/non-interactive-mode), [versioned exec event types](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/exec_events.rs), and [versioned JSONL emitter](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs). Installed version and source contracts were inspected on 2026-09-17.

## Activation and recovery — not performed

This change is independent of the native contact PR. Review and merge each separately only with authorization. Before rollout, verify the deployed Sokosumi parser matches the inspected contract, and confirm ingress/proxy buffering is disabled (`X-Accel-Buffering: no` is emitted). Retain authenticated ingress and private state. Drain the active coordinator turn, back up state, deploy the reviewed commit to the designated service checkout and restart only the authorized bridge/runner. A fresh turn then uses the new projection and scoped control path automatically; no new runtime credential or configuration is required.

During an authorized acceptance test, request a harmless operation that produces commentary followed by tool activity. Confirm a progress beat appears before the final answer and final text excludes that beat. Test reader disconnect/reconnect with an idempotent client; separately validate the browser path. A blank trace on an unknown Codex version does not justify exposing raw reasoning. For rollback, settle the active turn, preserve SQLite and recovery journals, and restore the prior reviewed code during authorized maintenance. Do not launch another turn to recover a lost stream.

No merge, running checkout update, restart, deployment, new worker/task, email or native DM send was performed. Existing task-event HTTP 422 reporting remains unresolved and is not retried or changed by this feature.
