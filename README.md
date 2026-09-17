# CodePat

CodePat connects Sokosumi conversations and tasks to a persistent coding coordinator and concurrent Herdr workers. This standalone repository contains the CLI, HTTP bridge, SQLite state, runner, operating prompt, registration/service scripts, example configuration and tests. It does not need the Sokosumi monorepo, database or build system.

The coordinator runs Codex. Workers use Codex or Claude Code in isolated Git worktrees. A background monitor keeps observing workers while the coordinator answers other requests. Project selection is explicit and checked against the requesting user's accessible Sokosumi workspace. Existing tasks and workers retain their identities.

**Use only with trusted collaborators.** Agents run with the host account's filesystem, network and Git credentials. Codex runs with full access and no approval prompts. The chat organization header is a filter, not authentication; deploy trusted ingress before exposing chat. See [security and operations](docs/operations.md).

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

This repository contains source and example configuration, not a running service. Running CodePat requires your own service and agent credentials; publishing or cloning this repository does not expose or deploy an endpoint. No npm registry publication is required. `npm link` optionally installs the `codepat` command from this checkout; `node src/cli.ts` works without linking. There is no build step or external runtime dependency. Node's built-in TypeScript stripping and SQLite provide execution/storage. Development dependencies are pinned in `package-lock.json`.

For a real host, follow [setup](docs/setup.md) in order: Linux/systemd and Herdr, agent authentication, GitHub access, Sokosumi registration/workspace access, private configuration, trusted proxy/TLS, then explicit service installation. Installing the service starts it; the test quickstart above does not.

## Where to look

| File | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/client.ts` | Scoped controller CLI; explicit owner-authenticated project reassignment |
| `src/http.ts`, `src/attachments.ts` | Conversations/Responses HTTP contract, streams, attachment validation |
| `src/runtime.ts`, `src/state.ts` | Durable jobs, task intake, worker operations, delivery/recovery/lifecycle |
| `src/main.ts`, `src/runner.ts` | Independent monitor loops, Herdr runner watchdog, supervised Codex turns |
| `src/herdr.ts`, `src/repository.ts` | Herdr CLI adapter and isolated worktree preparation |
| `src/projects.ts` | Paginated project access checks and owner task reassignment |
| `src/register.ts`, `src/install.ts`, `deploy/` | Explicit registration/install actions and sanitized templates |
| `CODEPAT.md` | Coordinator operating prompt, rendered into its private runtime directory |

[Chat deadlines and recovery](docs/recovery.md) covers timeout classification, safe retry boundaries and reboot preparation. [Architecture and operations](docs/operations.md) covers monitoring, steering, results, cleanup, recovery, trust and troubleshooting. [Projects](docs/projects.md) records the live API/auth contract and commands. [Verification](docs/verification.md) separates automated evidence from integration prerequisites. [NOTICE](NOTICE) and [LICENSE](LICENSE) preserve upstream attribution and terms.
