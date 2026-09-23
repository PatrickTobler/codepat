# Live progress streaming

CodePat projects safe coordinator progress from the Codex JSONL stream into durable SQLite state, then emits it through the Sokosumi Responses-compatible SSE connection before the final answer.

The public stream contains only:

- Fixed activity labels.
- Explicit assistant commentary selected by the inspected Codex event contract.
- The final answer as a separate output item.

It excludes reasoning, tool arguments/results, commands, file contents, environment values and opaque provider events. Unknown Codex versions fall back to fixed activity labels instead of attempting to interpret private fields.

Each progress item has a stable key. Ingestion is job-scoped and idempotent, survives bridge restart, and rejects another job's credential. `Last-Event-ID` resumes only the same response generation and refuses future or unrelated cursors. A disconnected reader does not cancel the durable turn.

This is activity streaming, not token-by-token model output. Herdr panes and delegated-agent transcripts are not scraped or broadcast.
