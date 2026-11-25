# Sokosumi CLI on the CodePat host

CodePat workers can call `sokosumi`, the developer CLI from
`masumi-network/sokosumi` (`apps/cli`). The npm release lags behind main and
lacks `evals`, so the host builds it from a main checkout.

## Layout

| What | Where |
| --- | --- |
| Checkout (shallow, main) | `~/.local/share/codepat/sokosumi-cli/src` |
| Wrapper on PATH | `~/.local/bin/sokosumi` (runs `apps/cli/dist/bin/sokosumi.js` with Node 26) |
| Update | `~/.local/share/codepat/sokosumi-cli/update.sh` |
| Skills | `~/.claude/skills/sokosumi*` and `~/.agents/skills/sokosumi*` |
| Optional key file | `~/.config/codepat/sokosumi-cli.env` (mode 600, unused while OAuth works) |

`update.sh` fetches main, rebuilds the CLI and copies the CLI's skills again.

## Sign-in

Patrick signs the CLI in on the host himself with `sokosumi auth login`
(OAuth, stored in the macOS keychain of the bridge user). An OAuth login
expires. Before using the CLI, run `sokosumi auth status`. When it says
`Authenticated: no`, tell Patrick in the task or chat that the Sokosumi CLI
needs a new sign-in on the Mac Mini, and stop. Do not try other keys,
environment variables or someone else's login.

Alternatively the wrapper loads `SOKOSUMI_API_KEY` from the key file when the
variable is unset. Only Patrick installs that file. Never pass a key as an
argument or print it.

## Use

```sh
sokosumi auth status
sokosumi evals cases
sokosumi evals run --suite cmo --cuso-version cmo-v22 --cases ID --repeats 1 --wait
sokosumi evals show RUN_ID --markdown
sokosumi evals list --limit 10
```

Eval runs cost real money. Ask before any run likely to cost more than $5.
