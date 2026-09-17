import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "./herdr.ts";
import { prepareRepository } from "./repository.ts";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "codepat-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const repo = join(dir, "checkout");
  const remote = join(dir, "origin.git");
  await git(["init", "--initial-branch=main", source]);
  await git(["-C", source, "config", "user.name", "Repository Test"]);
  await git(["-C", source, "config", "user.email", "repository@example.test"]);
  writeFileSync(join(source, "README.md"), "Run the documented setup.\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "initial"]);
  await git(["clone", "--bare", source, remote]);
  await git(["clone", remote, repo]);
  return {
    dir,
    source,
    repo,
    remote,
    worktree: join(dir, "worker"),
    branch: "codepat/task",
  };
}

test("fetches latest remote default without changing dirty parent or existing branch", async (t) => {
  const f = await fixture(t);
  const original = await git(["-C", f.repo, "rev-parse", "HEAD"]);
  await git(["-C", f.repo, "branch", "existing-work"]);
  writeFileSync(join(f.repo, "README.md"), "local unfinished work\n");
  writeFileSync(
    join(f.source, "AGENTS.md"),
    "Install dependencies before editing.\n",
  );
  await git(["-C", f.source, "add", "."]);
  await git(["-C", f.source, "commit", "-m", "new remote setup"]);
  await git(["-C", f.source, "push", f.remote, "main"]);
  const latest = await git(["-C", f.source, "rev-parse", "HEAD"]);
  const result = await prepareRepository(f);
  assert.equal(result.baseBranch, "main");
  assert.equal(result.baseCommit, latest);
  assert.equal(await git(["-C", f.worktree, "rev-parse", "HEAD"]), latest);
  assert.equal(await git(["-C", f.repo, "rev-parse", "HEAD"]), original);
  assert.equal(
    await git(["-C", f.repo, "rev-parse", "existing-work"]),
    original,
  );
  assert.equal(
    readFileSync(join(f.repo, "README.md"), "utf8"),
    "local unfinished work\n",
  );
  assert.match(result.setupInstructions, /AGENTS.md, README.md/);
  assert.equal(
    await git(["-C", f.repo, "for-each-ref", "refs/codepat/bases"]),
    "",
  );
});

test("selects explicit remote base and refuses an existing worker branch", async (t) => {
  const f = await fixture(t);
  await git(["-C", f.source, "checkout", "-b", "release"]);
  await git(["-C", f.source, "commit", "--allow-empty", "-m", "release"]);
  await git(["-C", f.source, "push", f.remote, "release"]);
  const result = await prepareRepository({ ...f, baseBranch: "release" });
  assert.equal(
    result.baseCommit,
    await git(["-C", f.source, "rev-parse", "HEAD"]),
  );
  await assert.rejects(
    prepareRepository({
      ...f,
      worktree: join(f.dir, "duplicate"),
      baseBranch: "release",
    }),
  );
  assert.equal(existsSync(join(f.dir, "duplicate")), false);
});

test("rejects invalid or unavailable bases without falling back to local HEAD", async (t) => {
  const f = await fixture(t);
  for (const baseBranch of [
    "--upload-pack=bad",
    "main~1",
    "missing",
    "HEAD",
    "",
  ]) {
    await assert.rejects(prepareRepository({ ...f, baseBranch }));
    assert.equal(existsSync(f.worktree), false);
  }
  await git([
    "-C",
    f.repo,
    "remote",
    "set-url",
    "origin",
    join(f.dir, "missing.git"),
  ]);
  await assert.rejects(prepareRepository({ ...f, baseBranch: "main" }));
  assert.equal(existsSync(f.worktree), false);
});

test("local repositories require explicit HEAD mode", async (t) => {
  const f = await fixture(t);
  await git(["-C", f.repo, "remote", "remove", "origin"]);
  await assert.rejects(prepareRepository(f), /explicitly select HEAD/);
  const result = await prepareRepository({ ...f, baseBranch: "HEAD" });
  assert.equal(
    result.baseCommit,
    await git(["-C", f.repo, "rev-parse", "HEAD"]),
  );
  assert.equal(result.baseBranch, "HEAD");
});

test("accepts standard origin-tracking and fully qualified branch names", async (t) => {
  const f = await fixture(t);
  for (const [index, baseBranch] of [
    "origin/main",
    "refs/remotes/origin/main",
    "refs/heads/main",
  ].entries()) {
    const result = await prepareRepository({
      ...f,
      baseBranch,
      branch: `codepat/form-${index}`,
      worktree: join(f.dir, `worker-${index}`),
    });
    assert.equal(result.baseBranch, "main");
    assert.equal(
      result.baseCommit,
      await git(["-C", f.source, "rev-parse", "main"]),
    );
  }
});
