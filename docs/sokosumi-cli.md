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
| Key file | `~/.config/codepat/sokosumi-cli.env` (mode 600) |

`update.sh` fetches main, rebuilds the CLI and copies the CLI's skills again.

## Credential

The CLI reads `SOKOSUMI_API_KEY`. The wrapper loads it from the key file when
the variable is unset, so the bridge, Herdr panes and shells all get it without
a restart. The key is CodePat's own user API key for mainnet. `evals` needs a
platform admin account. Never pass a key as an argument or print it.

Install or rotate the key on the host:

```sh
umask 077
mkdir -p ~/.config/codepat
read -rs KEY && printf 'SOKOSUMI_API_KEY=%s\n' "$KEY" > ~/.config/codepat/sokosumi-cli.env; unset KEY
sokosumi auth status
```

## Use

```sh
sokosumi auth status
sokosumi evals cases
sokosumi evals run --suite cmo --cuso-version cmo-v22 --cases ID --repeats 1 --wait
sokosumi evals show RUN_ID --markdown
sokosumi evals list --limit 10
```

Eval runs cost real money. Ask before any run likely to cost more than $5.
