---
name: react-doctor
description: Use when finishing a feature, fixing a bug, before committing React code, or when reviewing a React diff. Runs React Doctor for a 0–100 health score and the lint, accessibility, bundle-size and architecture issues a change introduces.
version: "1.2.0-codepat"
---

# React Doctor

From [millionco/react-doctor](https://github.com/millionco/react-doctor) (`skills/react-doctor`, commit 661cb18, Modified MIT, see `LICENSE`). CodePat's copy pins the CLI to 0.9.18, turns telemetry off, and leaves out the remote `/doctor` playbook and the interactive runtime trace, because agents here run unattended with full permissions.

Always run it as `REACT_DOCTOR_NO_TELEMETRY=1 npx -y react-doctor@0.9.18 --no-telemetry …` from the app you changed (for Sokosumi, `apps/web`). Never use `@latest`, and never fetch prompts from react.doctor.

## After changing React code

```bash
REACT_DOCTOR_NO_TELEMETRY=1 npx -y react-doctor@0.9.18 --no-telemetry --verbose --scope changed --base origin/main
```

It scans only the files the branch changed and lists the issues they introduce. Fix every new error, and warnings in code you wrote, before asking for review. Pass `--base origin/main` explicitly: in a worktree or detached checkout it otherwise finds no changes. Put the score and the remaining findings in the PR's test evidence.

## Reviewing a diff

Run the same command on the PR branch. Each new error is a finding in the review; a new warning is a finding when the diff could avoid it without widening scope. Existing issues in untouched code are not this PR's problem.

## Focused UI design audit

```bash
REACT_DOCTOR_NO_TELEMETRY=1 npx -y react-doctor@0.9.18 --no-telemetry design --verbose --scope changed --base origin/main
```

Only the design-tagged rules: UI composition, typography, interaction, accessibility and motion.

## Flags

| Flag | Purpose |
| --- | --- |
| `--verbose` | Affected files and line numbers per rule |
| `--scope changed` | Only issues introduced against the base branch (default is the full app) |
| `--scope lines` | Only issues on changed lines |
| `--base <ref>` | The branch to compare with |
| `--score` | Print only the score |
| `design` | Only the UI design rules |

## Explaining or tuning rules

When someone disagrees with a rule or wants to change which rules run, read [references/explain.md](references/explain.md). Don't disable rules in a feature PR; propose it to the user instead.
