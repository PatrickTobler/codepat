import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { TurnFailure, protocolFailureText } from "./turn-failure.ts";
import { failureKind, failureText } from "./recovery.ts";

test("exec JSONL process exit preserves policy diagnostic without exposing provider body", async () => {
  const events = [
    {type: "error", message: "Transient unknown error"},
    {type: "turn.failed", error: {message: "This content was flagged for possible cybersecurity risk. private-token/example-url"}},
  ];
  const child = spawn(process.execPath, ["-e", 'for(const x of JSON.parse(process.argv[1]))console.log(JSON.stringify(x));process.exitCode=1', JSON.stringify(events)]);
  const failure = new TurnFailure();
  const lines = createInterface({input: child.stdout});
  lines.on("line", line => failure.ingest(JSON.parse(line)));
  const [code] = await once(child, "close");
  const kind = failure.resolve(failureKind("exit-code", code, false, false, true))!;
  assert.equal(kind, "provider_policy");
  assert.match(failureText(kind), /safety-policy/);
  assert.doesNotMatch(JSON.stringify(failure) + failureText(kind), /private-token|example-url/);
});

test("allowlisted structured diagnoses and unknown errors remain sanitized", () => {
  for (const [code, expected] of Object.entries({
    cyber_policy:"provider_policy", Unauthorized:"provider_auth", UsageLimitExceeded:"provider_usage_limit",
    rate_limit_exceeded:"provider_rate_limit", ContextWindowExceeded:"provider_context_limit",
    ResponseStreamDisconnected:"provider_connection", unknown_secret:"provider_failure",
  })) {
    const f = new TurnFailure();
    f.ingest({type:"turn.failed",error:{codex_error_info:code,message:"sensitive text"}});
    assert.equal(f.resolve("turn_exit_failure"), expected);
    assert.doesNotMatch(JSON.stringify(f), /sensitive|unknown_secret/);
    assert.ok(protocolFailureText(expected));
  }
  assert.equal(protocolFailureText("injected-secret"), undefined);
  assert.equal(protocolFailureText("__proto__"), undefined);
});

test("transient errors do not fail success; terminal failure cannot be hidden by output or zero exit", () => {
  const f = new TurnFailure(); f.ingest({type:"error",message:"Stream disconnected before completion: private"});
  assert.equal(f.resolve(undefined), undefined);
  assert.equal(f.resolve("turn_exit_failure"), "provider_connection");
  f.ingest({type:"turn.failed",error:{message:"Unknown terminal failure"}});
  f.ingest({type:"turn.completed"});
  assert.equal(f.resolve(undefined), "provider_failure");
  for (const os of ["turn_timeout","turn_oom_killed","turn_signal","turn_interrupted"]) assert.equal(f.resolve(os), os);
});

test("tool failure, arbitrary output and private reasoning never become diagnostics", () => {
  const f=new TurnFailure();
  for (const event of [
    {type:"item.completed",item:{type:"command_execution",exit_code:1,aggregated_output:"This content was flagged for possible cybersecurity risk."}},
    {type:"reasoning",error:{codex_error_info:"cyber_policy"}},
    {type:"response_item",payload:{type:"turn.failed",error:{code:"Unauthorized"}}},
    null, "private transcript", {type:"turn.failed-ish"},
  ]) assert.equal(f.ingest(event),false);
  assert.equal(f.resolve("turn_exit_failure"),"turn_exit_failure");
  assert.equal(f.resolve(undefined),undefined);
});
