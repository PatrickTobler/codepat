#!/usr/bin/env node
// Daily cleanup for the loops' leftovers on this host.
//   node scripts/loop-hygiene.ts <sokosumi-repo> <memory-dir> [--apply]
// Without --apply it only reports. Touches only loop branches (sokd-<n>-onboarding-ux, sokd-<n>-app-ux-<area>)
// and their worktrees in <sokosumi-repo>/../sokosumi-ux; open PRs are reported, never changed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const REPO = "masumi-network/sokosumi";
const LOOP_BRANCH = /^sokd-(\d+)-(onboarding-ux|app-ux-[a-z0-9-]+)$/;
const WAITING_DAYS = 3;
const KEEP_RUN_DAYS = 14;
const HERDR = join(homedir(), ".local/bin/herdr");
const DAY = 86_400_000;

type Pr = {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: string;
  updatedAt: string;
  closedAt: string | null;
};
type Pane = { pane_id: string; tab_id: string; cwd?: string; foreground_cwd?: string; agent?: string | null; agent_status?: string };

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function loopPrs(): Pr[] {
  const fields = "number,url,title,headRefName,headRefOid,state,mergeable,updatedAt,closedAt";
  const all: Pr[] = JSON.parse(run("gh", ["pr", "list", "-R", REPO, "--state", "all", "--limit", "200", "--search", "head:sokd-", "--json", fields]));
  return all.filter((pr) => LOOP_BRANCH.test(pr.headRefName));
}

function herdr(args: string[]): unknown {
  return JSON.parse(run(HERDR, args)).result;
}

function panes(): Pane[] {
  if (!existsSync(HERDR)) return [];
  const { workspaces } = herdr(["workspace", "list"]) as { workspaces: { workspace_id: string }[] };
  return workspaces.flatMap((w) => (herdr(["pane", "list", "--workspace", w.workspace_id]) as { panes: Pane[] }).panes);
}

function inPr(repo: string, head: string, pr: Pr): boolean {
  run("git", ["-C", repo, "fetch", "-q", "origin", `refs/pull/${pr.number}/head`]);
  try {
    run("git", ["-C", repo, "merge-base", "--is-ancestor", head, pr.headRefOid]);
    return true;
  } catch {
    return false;
  }
}

function prNumber(value: unknown): number | undefined {
  const match = String(value ?? "").match(/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function main(): void {
  const [repo, memory] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  if (!repo || !memory) {
    console.error("usage: scripts/loop-hygiene.ts <sokosumi-repo> <memory-dir> [--apply]");
    process.exit(2);
  }
  const now = Date.now();
  const prs = loopPrs();
  const byBranch = new Map(prs.map((pr) => [pr.headRefName, pr]));
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const done: string[] = [];
  const attention: string[] = [];

  const worktreeRoot = join(dirname(repo), "sokosumi-ux");
  const allPanes = panes();
  const worktrees = run("git", ["-C", repo, "worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((block) => ({
      path: block.match(/^worktree (.+)$/m)?.[1] ?? "",
      head: block.match(/^HEAD (\w+)$/m)?.[1] ?? "",
      branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "",
    }))
    .filter((w) => w.path.startsWith(`${worktreeRoot}/`));
  for (const worktree of worktrees) {
    const name = basename(worktree.path);
    const pr = byBranch.get(worktree.branch);
    if (!pr) {
      attention.push(`${name}: worktree on \`${worktree.branch || "detached HEAD"}\` has no loop PR; left in place.`);
      continue;
    }
    if (pr.state === "OPEN") continue;
    const inside = (p: Pane) => [p.cwd, p.foreground_cwd].some((c) => c === worktree.path || c?.startsWith(`${worktree.path}/`));
    const tabs = [...new Set(allPanes.filter(inside).map((p) => p.tab_id))];
    const busy = tabs.filter((tab) => allPanes.some((p) => p.tab_id === tab && p.agent_status === "working"));
    const dirty = run("git", ["-C", worktree.path, "status", "--porcelain"]);
    if (busy.length || dirty || !inPr(repo, worktree.head, pr)) {
      const why = busy.length ? `an agent is still working in ${busy.join(", ")}` : dirty ? "it has uncommitted changes" : "it has commits that are not in the PR";
      attention.push(`${name}: PR #${pr.number} is ${pr.state.toLowerCase()}, but ${why}; left in place.`);
      continue;
    }
    if (apply) {
      for (const tab of tabs) run(HERDR, ["tab", "close", tab]);
      run("git", ["-C", repo, "worktree", "remove", worktree.path]);
      run("git", ["-C", repo, "branch", "-D", worktree.branch]);
    }
    done.push(`${name}: removed worktree and branch${tabs.length ? ` and closed ${tabs.length} tab${tabs.length > 1 ? "s" : ""}` : ""} (PR #${pr.number} ${pr.state.toLowerCase()}).`);
  }

  const areasDir = join(memory, "app-ux", "areas");
  for (const file of existsSync(areasDir) ? readdirSync(areasDir).filter((f) => f.endsWith(".json")) : []) {
    const path = join(areasDir, file);
    const area = JSON.parse(readFileSync(path, "utf8"));
    const prByTask = new Map<string, number | undefined>((area.audits ?? []).map((a: { task: string; pr: unknown }) => [a.task, prNumber(a.pr)]));
    let changed = 0;
    for (const finding of area.findings ?? []) {
      if (finding.status !== "in-pr") continue;
      const pr = byNumber.get(prByTask.get(finding.task) ?? -1);
      if (!pr || pr.state === "OPEN") continue;
      finding.status = pr.state === "MERGED" ? "merged" : "rejected";
      changed++;
    }
    if (changed && apply) writeFileSync(path, `${JSON.stringify(area, null, 2)}\n`);
    if (changed) done.push(`${area.area}: marked ${changed} finding${changed > 1 ? "s" : ""} from resolved PRs as merged or rejected.`);
  }

  for (const loop of ["app-ux/runs", "onboarding-ux"]) {
    const dir = join(memory, loop);
    for (const folder of existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f)) : []) {
      const path = join(dir, folder);
      if (!statSync(path).isDirectory()) continue;
      const id = folder.match(/SOKD-(\d+)$/)?.[1];
      const pr = id ? prs.find((p) => p.headRefName.startsWith(`sokd-${id}-`)) : undefined;
      const resolvedAt = pr ? (pr.state === "OPEN" ? undefined : Date.parse(pr.closedAt ?? pr.updatedAt)) : Date.parse(folder.slice(0, 10)) + 16 * DAY;
      if (!resolvedAt || now - resolvedAt < KEEP_RUN_DAYS * DAY) continue;
      if (apply) rmSync(path, { recursive: true });
      done.push(`${loop}/${folder}: deleted run folder (screenshots, inbox logins and account data) ${KEEP_RUN_DAYS}+ days after its PR closed.`);
    }
  }

  for (const pr of prs.filter((p) => p.state === "OPEN")) {
    const days = Math.floor((now - Date.parse(pr.updatedAt)) / DAY);
    if (pr.mergeable === "CONFLICTING")
      attention.push(`[PR #${pr.number}](${pr.url}) conflicts with main. Reply on its task to have it rebased, or **delete** it.`);
    if (days >= WAITING_DAYS)
      attention.push(`[PR #${pr.number}](${pr.url}) has waited ${days} days for **merge** or **delete**.`);
  }

  if (apply && run("git", ["-C", memory, "status", "--porcelain"])) {
    run("git", ["-C", memory, "add", "-A"]);
    run("git", ["-C", memory, "commit", "-qm", `hygiene ${new Date(now).toISOString().slice(0, 10)}`]);
    done.push("Committed loop memory.");
  }

  const open = prs.filter((p) => p.state === "OPEN").length;
  console.log(JSON.stringify({ apply, openLoopPrs: open, done, attention }, null, 2));
}

main();
