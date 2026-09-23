# Setup

CodePat is a trusted Sokosumi-to-Herdr gateway. Install it only on a host where authenticated Sokosumi users are allowed to exercise the service account's full shell, filesystem, network, Git and deployment credentials.

## Host prerequisites

- Linux with a working systemd user manager and lingering enabled for the service account.
- Node.js 24, npm, Git and Herdr 0.9 or newer.
- An authenticated Codex CLI. Claude Code is optional as the pre-action fallback.
- A running headless Herdr server for the same Unix account.
- Caddy or another trusted ingress proxy.

Authenticate GitHub and deployment tools exactly as for local Herdr. The coordinator deliberately inherits that access. Do not place credentials in the repository, prompt or public logs.

## Configuration

Copy `deploy/environment.example` to `~/.config/codepat/environment`, keep it mode `0600`, and configure:

| Variable | Purpose |
| --- | --- |
| `CODEPAT_ORGANIZATION_ID` | Exact Sokosumi organization accepted by the chat endpoint |
| `CODEPAT_OWNER_ID` | Optional single-user allowlist for the chat endpoint |
| `CODEPAT_REPO` | Default checkout or workspace directory |
| `CODEPAT_PORT` | Loopback HTTP port; defaults to `3210` |
| `CODEPAT_DATA_DIR` | Private SQLite, attachments, scopes and runner files |
| `CODEPAT_API_URL` | Sokosumi API base; defaults to `https://api.sokosumi.com/v1` |
| `CODEPAT_COWORKER_ID` | Registered CodePat coworker ID; enables task intake with the API key |
| `CODEPAT_API_KEY` | Dedicated coworker key for task reads and reports |
| `CODEPAT_REPOSITORIES_JSON` | Optional repository shortcuts; not an access allowlist |
| `CODEPAT_CHAT_TIMEOUT_MS` | Chat turn deadline, 60 seconds to one hour |
| `CODEPAT_BACKGROUND_TIMEOUT_MS` | Task turn deadline, 60 seconds to one hour |

Run `node src/register.ts` once with the vendor registration variables described by its source when a CodePat coworker does not yet exist. Remove the vendor/admin credential after registration; normal runtime needs only the dedicated coworker key.

## Install

```sh
npm ci
npm test
npm run typecheck
node src/install.ts
systemctl --user status codepat.service
curl -fsS http://127.0.0.1:3210/health
```

The installer writes and enables `~/.config/systemd/user/codepat.service`. It starts the bridge, which creates or reuses one Herdr workspace and runner pane without taking focus.

## Ingress

The HTTP chat contract trusts Sokosumi identity headers after checking the configured organization and stored conversation owner. Those headers are not cryptographic authentication by themselves. Expose the endpoint only through ingress that authenticates Sokosumi, a private network, or an equivalent trusted route. Anyone able to submit an accepted chat request can instruct a full-access coding agent.

The supplied Caddy example terminates TLS and limits published routes. It does not authenticate callers by itself.

## Acceptance check

From Sokosumi:

1. Start a chat and ask CodePat to report its Herdr workspace and agent inventory.
2. Ask it to run a harmless read-only host command and return the result.
3. Assign a small task, verify that it appears once, moves to RUNNING, and receives one final report.
4. Ask CodePat to create and inspect a temporary Herdr agent, then close only the pane it created.
5. Restart `codepat.service` while idle and verify the existing conversation continues.

No separate CodePat worker registry, worktree manager, approval parser or periodic reviewer should appear.
