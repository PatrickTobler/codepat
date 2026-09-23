import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeTurn, claudeArgs, claudeSessionId, shouldFallBack } from "./orchestrator-fallback.ts";

test("falls back only when Codex was unavailable before acting", () => {
  for (const kind of ["provider_usage_limit", "provider_auth", "provider_rate_limit", "provider_connection", "provider_context_limit"]) {
    assert.equal(shouldFallBack(kind, false), true, kind);
    assert.equal(shouldFallBack(kind, true), false, `${kind} after acting`);
  }
  for (const kind of [undefined, "provider_policy", "provider_failure", "turn_timeout", "turn_exit_failure", "turn_oom_killed"])
    assert.equal(shouldFallBack(kind, false), false, String(kind));
});

test("each conversation maps to one stable, valid Claude session id", () => {
  const id = claudeSessionId("conv_a");
  assert.equal(id, claudeSessionId("conv_a"));
  assert.notEqual(id, claudeSessionId("conv_b"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Claude turns create, then resume, the conversation session", () => {
  const home = mkdtempSync(join(tmpdir(), "codepat-claude-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const cwd = "/home/u/.local/share/codepat/orchestrator";
    const id = claudeSessionId("conv_a");
    const first = claudeArgs({ conversationId: "conv_a", cwd });
    assert.deepEqual(first.slice(-2), ["--session-id", id]);
    assert.ok(first.includes("bypassPermissions") && first.includes("stream-json"));
    const project = join(home, "projects", "-home-u--local-share-codepat-orchestrator");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), "");
    assert.deepEqual(claudeArgs({ conversationId: "conv_a", cwd }).slice(-2), ["--resume", id]);
    const detached = claudeArgs({ cwd });
    assert.ok(detached.includes("--no-session-persistence"));
    assert.ok(!detached.includes(id));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("only a successful Claude result event produces the answer", () => {
  const ok = new ClaudeTurn();
  assert.equal(ok.ingest({ type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text", text: "Queued." }] } }), "Queued.");
  assert.equal(ok.text, undefined);
  ok.ingest({ type: "result", subtype: "success", is_error: false, result: "Queued for cp-1." });
  assert.deepEqual([ok.completed, ok.failed, ok.text], [true, false, "Queued for cp-1."]);
  const failed = new ClaudeTurn();
  failed.ingest({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached" });
  assert.deepEqual([failed.completed, failed.failed, failed.text], [true, true, undefined]);
  const maxTurns = new ClaudeTurn();
  maxTurns.ingest({ type: "result", subtype: "error_max_turns", is_error: false });
  assert.equal(maxTurns.failed, true);
});
