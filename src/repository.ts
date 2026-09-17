import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./herdr.ts";

export interface PrepareRepositoryOptions {
  repo: string;
  worktree: string;
  branch: string;
  baseBranch?: string;
}

export interface PreparedRepository {
  baseCommit: string;
  baseBranch: string;
  setupInstructions: string;
}

async function validateBranch(repo: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith("-") || branch === "HEAD")
    throw new Error("Invalid branch name");
  await git(["-C", repo, "check-ref-format", `refs/heads/${branch}`]);
}

export async function prepareRepository({
  repo,
  worktree,
  branch,
  baseBranch,
}: PrepareRepositoryOptions): Promise<PreparedRepository> {
  await validateBranch(repo, branch);
  const remotes = (await git(["-C", repo, "remote"])).split("\n");
  let baseCommit: string;
  if (!remotes.includes("origin")) {
    if (baseBranch !== "HEAD")
      throw new Error(
        "Repository has no origin; explicitly select HEAD for local work",
      );
    baseCommit = await git([
      "-C",
      repo,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
  } else {
    if (baseBranch === undefined) {
      const remoteHead = await git([
        "-C",
        repo,
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
      ]);
      baseBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remoteHead)?.[1];
      if (!baseBranch)
        throw new Error("Origin has no default branch; select a base branch");
    }
    baseBranch = baseBranch.replace(
      /^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/,
      "",
    );
    await validateBranch(repo, baseBranch);
    // Each worker resolves its own fetched commit, even during concurrent launches.
    const fetchedRef = `refs/codepat/bases/${randomUUID()}`;
    try {
      await git([
        "-C",
        repo,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        `refs/heads/${baseBranch}:${fetchedRef}`,
      ]);
      baseCommit = await git([
        "-C",
        repo,
        "rev-parse",
        "--verify",
        `${fetchedRef}^{commit}`,
      ]);
    } finally {
      await git(["-C", repo, "update-ref", "-d", fetchedRef]);
    }
  }
  await git([
    "-C",
    repo,
    "worktree",
    "add",
    "-b",
    branch,
    resolve(worktree),
    baseCommit,
  ]);
  const pointers = [
    "AGENTS.md",
    "README.md",
    "README",
    "CONTRIBUTING.md",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "pyproject.toml",
    "uv.lock",
    "Cargo.toml",
    "go.mod",
    "Makefile",
  ].filter((file) => existsSync(join(worktree, file)));
  return {
    baseCommit,
    baseBranch,
    setupInstructions: [
      `Work only in ${resolve(worktree)} on branch ${branch}, based on ${baseBranch} at ${baseCommit}.`,
      `Before editing, read the repository's prescribed setup and all applicable scoped AGENTS.md files. Root setup pointers: ${pointers.join(", ") || "none detected; inspect the repository documentation"}.`,
      "Follow those setup instructions, including the pinned runtime/package manager, dependency installation, environment bootstrap, generated files, and required local services. Run setup commands in this worktree. Do not copy credentials or change another checkout without authorization. Report missing prerequisites precisely.",
      "Finish with the test commands and results, changed files, and remaining blockers. Create a draft pull request only when authorized; preserve existing branches and worktrees.",
    ].join("\n"),
  };
}
