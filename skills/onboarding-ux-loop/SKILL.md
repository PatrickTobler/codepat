---
name: onboarding-ux-loop
description: Daily Sokosumi onboarding UX loop. Sign up as a brand-new user on a fresh mainnet-clone preview, screenshot every step, analyze the UX, ship 1–3 fixes as a PR, verify them on the PR preview, and wait for Patrick to say merge or delete. Use when a task asks to run the onboarding UX loop, or when a comment arrives on such a task.
---

# Onboarding UX loop

One run = one Sokosumi task = one PR in `masumi-network/sokosumi`. Every account lives only in that PR's Neon preview database (a clone of mainnet). Closing or merging the PR tears it down, so nothing reaches production data.

## Roles

- **Coordinator** (the CodePat task turn): prepares the run, starts one worker in Herdr, attaches its pane, reports RUNNING, and ends the turn. When the worker settles, it verifies the output, uploads files, and reports.
- **Worker** (Codex, or Claude when Codex is unavailable), started in the run's worktree. Run steps 1–5 there. The worker never calls `task-upload` or `task-report`; only the coordinator does.

Run directory: `~/.local/share/codepat/loops/onboarding-ux/<YYYY-MM-DD>/` holding `before/`, `after/`, `notes.md`, `report.md`, `result.json`. Ledger of past findings: `~/.local/share/codepat/loops/onboarding-ux/ledger.md`.

## Toolchain

- `codepat <command>` below means the CodePat CLI exactly as your operating prompt invokes it (`node …/src/cli.ts`). It only works inside a coordinator task turn.
- Sokosumi needs Node 26. Prefix every repo command with `export PATH=/opt/homebrew/opt/node/bin:$PATH`. Never relink Homebrew `node`; Codex and Claude depend on the linked Node 24.
- Mailbox: `node <this skill dir>/mailbox.ts create <run>/mailbox-<phase>.json` prints a fresh address. `node <this skill dir>/mailbox.ts code <run>/mailbox-<phase>.json 300` waits for the next 6-digit code and prints it.
- Browser: the `chrome-devtools` MCP. Open a new isolated context per walkthrough and resize to 1440×900. Previews use Cloudflare's always-pass Turnstile key, so no captcha appears. If a real challenge shows up anyway, stop and report it. Never try to get around it.
- Read the repo's `AGENTS.md` and `docs/agents/delivery.md` before committing. They take precedence over this skill, with two exceptions Patrick authorized: the PR goes ready for review (not draft), and it is merged on his explicit `merge` comment.

## Step 0: Coordinator prepares the run

1. `codepat task-status` gives the task identifier (e.g. `SOKD-412`). Branch: `<identifier lowercased>-onboarding-ux`.
2. `cd ~/workspaces/sokosumi && git fetch origin main`. Then `git worktree add ~/workspaces/sokosumi-ux/<identifier> -b <branch> origin/main`.
3. Create the run directory. Read the ledger and the bodies of open PRs labelled `user experience` whose branch ends in `-onboarding-ux`. Their findings are already being handled; do not redo them.
4. Start the worker in a new Herdr tab in that worktree with full local permissions. Prompt: "Use the onboarding-ux-loop skill. Run steps 1–5 for task <identifier> on branch <branch>. Run directory: <run>." Attach the pane with `task-runtime attach`. Report RUNNING with a one-line note, then end the turn.

## Step 1: Baseline preview

1. Previews only build when the PR touches `apps/` or `packages/`. Commit an empty-behavior marker `apps/web/.onboarding-ux-baseline` (contents: the date) as `chore(web): onboarding ux baseline marker`. Push.
2. Open the PR: `gh pr create --base main --label "user experience"`. Title: `fix(web): onboarding UX improvements <YYYY-MM-DD>` (adjust the type and scope once the fixes are known; the title must equal the primary commit subject). Body: "Daily onboarding UX run, in progress."
3. Comment `/deploy mainnet --reset-db` and note the comment time. Wait for readiness:
   - the `Preview deploy` workflow run (event `issue_comment`, created after your comment, mentioning this PR in its log) concludes `success` (`gh run watch <id> --exit-status`);
   - the Vercel bot comment shows `sokosumi-app-mainnet` and `sokosumi-core-mainnet` as Ready with a time after your comment;
   - `https://sokosumi-app-mainnet-git-<branch>.preview.sokosumi.com/signup` returns 200. Take the exact host from the Vercel comment; long branch names get shortened.
   If the deploy fails, read the workflow log, fix what is yours, and retry at most twice. Otherwise write the blocker into `result.json` and stop.

## Step 2: Walk through as a new user (before)

Behave like a first-time visitor who only has the link. Start at the preview root URL, not `/signup`, and find the way in through the UI. Use clicks and typing only. Do not jump to URLs, fill forms with JavaScript, or read the source to know what comes next.

- Use a fresh mailbox address. Pick a plausible first name, last name, and company per run. Take the email code from the mailbox helper.
- Screenshot every distinct screen and every state change that matters (validation errors, loading states longer than about 2 s, toasts, empty states, modals) to `before/NN-<slug>.png`. Use full-page screenshots when the content scrolls.
- For each screenshot, append to `notes.md`: what the user sees, what is asked of them, what they must already know, friction or confusion, copy problems, visual or layout defects, console errors (`list_console_messages`), slow steps with their timings.
- Walk all of onboarding: signup, email code, identity/setup, workspace/organization, assistant or connect steps, and any tour or checklist. Stop when the user lands in the normal app with nothing left to set up. Take one final screenshot there.
- Do not pay, buy credits, or connect real third-party accounts. If a step requires one, screenshot it, note it, and take the skip path. If there is no skip path, the walkthrough ends there.

## Step 3: Analyze and choose

Write `report.md`:
1. A step table: number, screenshot file, what happens, issues.
2. All findings, ranked by user impact (blocks progress > causes confusion or drop-off > polish). Each one cites its screenshot and is marked new or already in the ledger or an open PR.
3. The 1–3 fixes chosen for this PR: the highest-impact new findings that fit a small, reviewable diff in this repo. Explain why each was chosen and what the user will see differently.

Prefer fixes that remove a step, clarify a decision, fix a defect, or explain what happens next. Avoid redesigns, new dependencies, and backend or schema changes unless the finding cannot be fixed otherwise. If nothing worth fixing turns up, say so in `result.json`, close the PR with a comment, and skip step 4.

## Step 4: Implement and verify (after)

1. Delete the marker file. Implement the fixes following the repo's agent rules (Web UI conventions, i18n for every message, reuse existing components). Add or update focused tests.
2. Run checks for what you touched: `pnpm exec turbo run typecheck test --filter=@sokosumi/web` (plus other packages you changed) and `pnpm check`. Fix all findings.
3. Commit with a Conventional Commit subject, retitle the PR to match, and push.
4. Comment `/deploy mainnet --reset-db` again and wait as in step 1.3. Walk the same path with a new mailbox address, saving screenshots to `after/` with matching numbers and slugs where the step still exists. Confirm each fix is visible and nothing else regressed. If a fix does not hold, repair it (at most two rounds) or drop it and say so.

## Step 5: Worker hand-off

Write `result.json`:
`{ "pr": <url>, "preview": <url>, "fixes": [<one line each>], "dropped": [...], "blocker": null | <text>, "screenshots": { "before": [...], "after": [...] } }`
Append today's findings to the ledger, one line each: date, finding, status (`fixed in PR`, `open`, `won't fix`). Then stop. The coordinator takes over.

## Step 6: Coordinator delivers

1. Check `result.json` against the PR, the files, and the diff. Upload `report.md` and every screenshot, before and after, with `codepat task-upload --file <path>`. Keep the returned `fileUrl`s.
2. Update the PR body: summary, the fixes, the preview URL, and before/after image links (the uploaded `fileUrl`s) for each fixed step. The repo is public; that is fine for throwaway test-account screenshots. Mark the PR ready for review.
3. `task-report INPUT_REQUIRED` with a short comment: PR link, the fixes in one line each, the preview URL, the report link, and `Reply **merge** or **delete**.`
4. Stop the worker and close only the tab you created. Keep the worktree until the decision.

## Step 7: Patrick's decision (task comment)

- **merge**: confirm the PR head is what was verified and the required checks pass (`gh pr checks --required`). If checks fail, fix them, re-verify, and report back instead of merging. Otherwise run `gh pr merge --squash --delete-branch`. Mark ledger entries `merged`. Report COMPLETED with the merge commit.
- **delete**: `gh pr close --delete-branch --comment "Closed by request from the onboarding UX loop task."`. Mark ledger entries `rejected`. Report COMPLETED.
- **Anything else** is feedback. Apply it on the same branch, redeploy, re-shoot the affected steps, upload them, and return to INPUT_REQUIRED.

After merge or close, remove the run's worktree (`git worktree remove`; the branch is already on GitHub) and acknowledge the task input.
