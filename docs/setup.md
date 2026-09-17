# Reproduce the setup

## Prerequisites

Use a dedicated Linux account with a working systemd user manager, Git, Node 24, npm, Herdr and Codex. Claude Code is optional for `--kind claude`. Caddy and a DNS name are needed for the proxy example. GitHub CLI is useful for publishing branches and draft PRs. Each target repository may need its own runtimes and services; workers read that repository's setup instructions.

The inspected host has Node 24.21.0, npm 11.19.0, Herdr 0.9.0, Codex CLI 0.154.0 and Claude Code 2.1.272. These are observed versions, not proof that every upstream combination works. Automated tests mock Herdr and Sokosumi. Native Windows/macOS service installation is not implemented: the runner itself depends on Linux `systemd-run`.

Install Herdr from its [official installation instructions](https://herdr.dev/). Review/download the installation script or use a pinned release. Run `herdr --version`, `herdr --skill` and `herdr --help` to inspect your installed version. Start/attach your own persistent session with `herdr`; for headless startup use that release's server/service instructions. Do not point CodePat at another user's socket. The adapter expects JSON `{result: ...}` responses and workspace/tab/pane/agent commands shown in `src/herdr.ts` and `src/runtime.ts`. Configure its Codex and Claude integrations so agent names, working directories and states are reported.

Install and authenticate Codex as the service account using the [official CLI guide](https://developers.openai.com/codex/cli/). For example, `npm install -g @openai/codex`, then run `codex` to sign in. Keep its credentials in that account's private home. Install/authenticate optional Claude Code following [its setup guide](https://code.claude.com/docs/en/setup). Confirm `codex --version` and `claude --version` under the same account and PATH used by systemd. CodePat does not provision subscriptions or choose your model. Configure each CLI locally; no host-specific model settings are shipped.

Authenticate GitHub with `gh auth login` or your organization's SSH/credential-helper workflow, verify `gh auth status`, and configure your own Git author identity. Grant only needed repository access. Never put Git tokens in repository URLs or prompts. Clone the requested repository under your workspace directory; verify `git remote -v` before reuse. `start --repo /absolute/checkout --base main` fetches the requested remote branch into a temporary ref, resolves its commit and creates a new `codepat/<worker-id>` branch/worktree. It leaves the original checkout's branch and dirty files alone. Without `origin`, explicitly choose `--base HEAD`. Shortcuts in `CODEPAT_REPOSITORIES_JSON` are conveniences, not a filesystem allowlist.

## Private configuration

Run the test quickstart first. In your checkout:

```sh
install -d -m 700 "$HOME/.config/codepat"
install -m 600 deploy/environment.example "$HOME/.config/codepat/environment"
```

Edit the private file, replacing the organization ID and absolute default checkout path. This is systemd EnvironmentFile syntax: values do not expand `$HOME` or `~`. JSON repository maps need literal JSON, as in the template. The template contains no working credentials. The service installer preserves an existing environment file.

| Setting | Purpose/default |
| --- | --- |
| `CODEPAT_ORGANIZATION_ID` | Exact chat organization filter; required for chat |
| `CODEPAT_REPO` | Default local checkout; default `~/workspaces/default` |
| `CODEPAT_REPOSITORIES_JSON` | Optional object mapping shortcuts to absolute checkouts |
| `CODEPAT_DATA_DIR` | Private state directory; default `~/.local/share/codepat` |
| `CODEPAT_PORT` | Loopback port, default 3210 |
| `CODEPAT_API_URL` | Sokosumi API base, default `https://api.sokosumi.com/v1` |
| `CODEPAT_COWORKER_ID`, `CODEPAT_API_KEY` | Registered coworker ID and dedicated key; both enable task intake |
| `CODEPAT_WORKER_IDLE_MS` | Completed worker cleanup delay, default 900000; minimum 1000 |
| `HERDR_ENV`, `HERDR_SOCKET_PATH` | Set by installer; override socket for intended session |
| `CODEPAT_CONFIG` | CLI/runner private client JSON path; not the service environment file |
| `CODEPAT_JOB_ID` | Active request identity, set by runner for scoped coordinator commands |

Without coworker credentials task polling is disabled, and chat task creation cannot succeed. The CLI does not start an independent coordinator or create an active job on its own.

## Sokosumi registration

Use [live Sokosumi API docs](https://api.sokosumi.com/) to confirm your account/vendor's permissions. The one-time `node src/register.ts` script requires `SOKOSUMI_ADMIN_API_KEY`, `CODEPAT_VENDOR_ID` and `CODEPAT_PUBLIC_URL` (an HTTPS base URL ending in `/v1`). Supply these through a private environment/secret manager, never literal shell-history commands. The script creates a `CodePat` coworker with `chat` and `tasks`, then creates its dedicated API key. This explicit vendor registration credential is separate from runtime task-owner authentication.

The script saves `CODEPAT_COWORKER_ID` and `CODEPAT_API_KEY` to `~/.config/codepat/coworker.env` with mode 600, prints only the ID, and refuses to overwrite that file. If coworker creation succeeded but a later action failed, inspect the vendor's coworkers and retry with the verified `CODEPAT_COWORKER_ID`. Reconcile an uncertain create/key response before retrying: registration has no idempotency key. A lost API-key response may require revocation through Sokosumi before issuing another key.

Configure the vendor's workspace grant and the coworker's workspace/organization access and whitelist in Sokosumi. The requesting user must belong to the selected organization and satisfy upstream access/seat requirements. Merge the two runtime values into the private service environment file; remove the registration credential from the runtime environment. Do not give a vendor/admin credential to coding workers.

## Proxy and service

The server binds `127.0.0.1`; the example Caddy site forwards only `/v1/*` and `/health`, never `/control/*`. Replace `codepat.example.com` with your DNS name, configure DNS, firewall and certificate prerequisites, and validate the Caddy configuration before an explicitly authorized reload. Caddy handles TLS, but TLS alone does not authenticate chat callers. Establish trusted ingress (for example a private network or authenticated gateway agreed with your Sokosumi operator) before publishing these routes. CodePat itself trusts the user/organization headers described in operations; the template intentionally does not invent an upstream bearer contract.

Once configuration and access are ready, explicit installation starts the service:

```sh
node src/install.ts
systemctl --user status codepat.service
journalctl --user -u codepat.service -n 50
node src/cli.ts status
```

The installer writes `~/.config/systemd/user/codepat.service` with the checkout/Node paths, private umask, Herdr socket and PATH, then runs daemon-reload and enable --now. Paths containing whitespace, quotes or `%` are rejected. Ensure Herdr and agent binaries are in its PATH (Node's directory, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`); override PATH in the private environment if necessary. Enable the Herdr host service separately. If desired and authorized, `sudo loginctl enable-linger "$USER"` keeps the user manager available after logout.

On hosts without a shell user bus, set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`. A logged-in user manager is still required. For foreground diagnosis load the configured values into the process environment using your secret manager and run `node src/main.ts`; do not start a second instance against the same state, socket or port.

After installation, use Sokosumi to request a small task: inspect accessible projects, choose the correct one, start a worker, steer it and verify a structured result on the same task. Test Codex and optional Claude independently. Check proxy authentication, task ownership and restart recovery on a disposable host before wider access. These live provisioning/rollout steps were not run for this repository delivery.
