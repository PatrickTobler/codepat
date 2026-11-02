import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resetUnit, startUnit, stopUnit, unitState } from "./turn-unit.ts";

const darwin = { skip: process.platform !== "darwin" };
const closed = (child: ReturnType<typeof startUnit>) => new Promise(resolve => child.once("close", resolve));

test("stopping a turn kills its whole process group", darwin, async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-unit-"));
  const child = startUnit("t1", dir, "sh", ["-c", "sleep 30 & sleep 30"], {}, { runtimeSeconds: 60, stopSeconds: 1 });
  child.stdin!.end();
  assert.equal((await unitState("t1", dir)).activeState, "active");
  await stopUnit("t1", dir, 1);
  await closed(child);
  await delay(200);
  const state = await unitState("t1", dir);
  assert.equal(state.activeState, "inactive");
  assert.equal(state.result, "signal");
  await resetUnit("t1", dir);
  assert.equal((await unitState("t1", dir)).loadState, "not-found");
});

test("a turn past its runtime limit ends as a timeout", darwin, async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-unit-"));
  const child = startUnit("t2", dir, "sleep", ["30"], {}, { runtimeSeconds: 1, stopSeconds: 1 });
  child.stdin!.end();
  await closed(child);
  assert.equal((await unitState("t2", dir)).result, "timeout");
});

test("a clean exit passes stdin through and reports success", darwin, async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-unit-"));
  const child = startUnit("t3", dir, "cat", [], { EXTRA: "1" }, { runtimeSeconds: 10, stopSeconds: 1 });
  let out = "";
  child.stdout!.on("data", chunk => (out += chunk));
  child.stdin!.end("hello");
  await closed(child);
  assert.equal(out, "hello");
  assert.equal((await unitState("t3", dir)).result, "success");
});
