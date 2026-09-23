# CodePat

CodePat is a thin trusted gateway between Sokosumi and a local coding coordinator. Sokosumi conversations and tasks reach a persistent, full-access coordinator turn on this host; the coordinator uses the shell, Git, installed tools and the `herdr` CLI directly, exactly like the local user. This standalone repository contains the HTTP bridge, SQLite state, runner, small scoped CLI, operating prompt, registration/service scripts, example configuration and tests.

The coordinator runs Codex, falling back to Claude Code for a turn when Codex is unavailable (usage limit, auth, rate limit, connection or context limit) before it acted. Sokosumi owns conversations, tasks, assignment, status and event history; the bridge keeps only the minimal durable state for chat responses, idempotency, coordinator threads, progress, task-event deduplication, scoped turn credentials and task-report delivery.

**Use only with trusted collaborators.** The coordinator runs with the host account's filesystem, network and Git credentials, with no approval prompts. The chat organization header is a filter, not authentication; deploy trusted ingress before exposing chat. See [security and operations](docs/operations.md).

## Quickstart

For an offline source/test check, install Node 24 and Git, then:

```sh
git clone https://github.com/PatrickTobler/codepat.git
cd codepat
npm ci
npm test
npm run typecheck
node src/cli.ts --help
```

## Where to look

| File | Responsibility |
| --- | --- |
| `src/http.ts`, `src/attachments.ts` | Conversations/Responses HTTP contract, streams, attachment validation |
| `src/runtime.ts`, `src/state.ts` | Durable jobs, idempotency, task-event intake, scoped controls, task-report delivery |
| `src/main.ts`, `src/runner.ts` | Bridge loops, Herdr runner watchdog, supervised Codex turns with Claude fallback |
| `src/cli.ts`, `src/client.ts` | Scoped coordinator CLI; explicit owner-authenticated project reassignment |
| `src/herdr.ts` | Herdr CLI adapter for the bridge's own workspace and live inventory |
| `src/projects.ts` | Paginated project access checks and owner task reassignment |
| `src/recovery.ts`, `src/progress.ts` | Turn deadlines, receipts and safe live-progress projection |
| `src/register.ts`, `src/install.ts`, `deploy/` | Explicit registration/install actions and sanitized templates |
| `CODEPAT.md` | Coordinator operating prompt, rendered into its private runtime directory |

[Live progress streaming](docs/streaming.md) covers safe event selection, replay and Sokosumi compatibility. [Architecture and operations](docs/operations.md) covers the request lifecycle, trust, turn recovery and troubleshooting. [Projects](docs/projects.md) records the live API/auth contract and commands. [Verification](docs/verification.md) separates automated evidence from integration prerequisites. [NOTICE](NOTICE) and [LICENSE](LICENSE) preserve upstream attribution and terms.
