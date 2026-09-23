#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { reassignOwnedTask, userApi } from "./projects.ts";
import { record } from "./state.ts";
import { control } from "./client.ts";

const [action, ...args] = process.argv.slice(2);
if (action === "--help" || action === "help" || !action) {
  console.log(`CodePat (Node 24)
fresh-worker-plan <worker> | continue-worker-fresh <worker> --file <private-handoff.json>
worker-continuation-plan <worker>
reconcile-startup-notice <worker> --file <private-notice-evidence.json>
continue-worker-readonly <worker> --file <private-continuation.json>
worker-hold|inspect-worker-hold <worker>
record-worker-hold|reconcile-worker-hold <worker> --file <private-evidence.json>
worker-approve-routine <worker> --file <private-approval.json>
incident-report <incident-id> --kind failure|blocked|recovered --file <explanation>
review-status | review-work <worker> --state pending|waiting|done --file <note>
recover-chat <response-id> --reconciled --file <reconciliation>
status | repositories | instances | workers | projects | project <uuid>
task-projects [--repo <tracked-path-or-alias>] [--project <expected-uuid>]
contacts <name-or-email>
dm-send <stable-key> (--to <name-or-email> | --recipient <verified-user-id>) [--room <uuid>] [--coordination <authorized-task-purpose>] --file <message>
dm-status <stable-key> | dm-retry <stable-key>
start <stable-key> --file <prompt> --project <uuid> [--repo <path>] [--base <branch>] [--kind codex|claude|grok]
send|resume <worker> --file <instructions> [--recovery-evidence <private-session.json> (resume only)] | stop|read <worker>
worker-result <worker> --file <result> | task-report <status> --file <comment>
task-project <task> --project <uuid> --owner-config <private-json>
Coordinator commands require an active CODEPAT_JOB_ID and scoped CODEPAT_CONFIG.
Owner reassignment uses a separate explicit user credential; see docs/projects.md.`);
  process.exit(0);
}
function option(name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
if (action === "task-project") {
  const config = record(JSON.parse(readFileSync(option("--owner-config"), "utf8")));
  console.log(JSON.stringify(await reassignOwnedTask(userApi(config), config, args[0], option("--project")), null, 2));
  process.exit(0);
}
const fileIndex = args.indexOf("--file");
const content =
  fileIndex >= 0
    ? readFileSync(option("--file"), "utf8")
    : args.slice(1).join(" ");
const jobId = process.env.CODEPAT_JOB_ID;
let body: Record<string, unknown> = { jobId };
let route = action;
switch (action) {
  case "fresh-worker-plan":
  case "worker-continuation-plan":
  case "worker-hold":
  case "inspect-worker-hold":
    body={jobId,workerId:args[0]};break;
  case "reconcile-startup-notice":
  case "continue-worker-fresh":
  case "continue-worker-readonly":
  case "record-worker-hold":
  case "reconcile-worker-hold":
  case "worker-approve-routine":
    body={jobId,workerId:args[0],evidence:JSON.parse(readFileSync(option("--file"),"utf8"))};break;
  case "incident-report":
    body = { jobId, incidentId: args[0], kind: option("--kind"), text: readFileSync(option("--file"), "utf8") };
    break;
  case "task-projects":
    body = { jobId, ...(args.includes("--repo") ? { repository: option("--repo") } : {}), ...(args.includes("--project") ? { projectId: option("--project") } : {}) };
    break;
  case "contacts":
    body = { jobId, query: args[0] };
    break;
  case "dm-status":
  case "dm-retry":
    body = { jobId, key: args[0] };
    break;
  case "dm-send":
    if (args.includes("--to") === args.includes("--recipient"))
      throw new Error("Select exactly one --to or --recipient");
    body = {
      jobId, key: args[0], text: readFileSync(option("--file"), "utf8"),
      ...(args.includes("--to") ? { query: option("--to") } : { recipientId: option("--recipient") }),
      ...(args.includes("--room") ? { roomId: option("--room") } : {}),
      ...(args.includes("--coordination") ? { coordination: option("--coordination") } : {}),
    };
    break;
  case "review-status":
    break;
  case "review-work":
    body = { jobId, workerId: args[0], state: option("--state"), text: content };
    break;
  case "recover-chat":
    if (!args.includes("--reconciled")) throw new Error("Explicit reconciliation is required");
    body = { jobId, responseId: args[0], reconciled: true, reconciliation: readFileSync(option("--file"), "utf8") };
    break;
  case "status":
    break;
  case "project":
    body = { jobId, projectId: args[0] };
    break;
  case "projects":
  case "repositories":
  case "instances":
  case "workers":
    break;
  case "start":
    body = {
      jobId,
      key: args[0],
      prompt: content,
      ...(args.includes("--project") ? { projectId: option("--project") } : {}),
      ...(args.includes("--kind")
        ? { kind: option("--kind") }
        : {}),
      ...(args.includes("--repo")
        ? { repository: option("--repo") }
        : {}),
      ...(args.includes("--base")
        ? { baseBranch: option("--base") }
        : {}),
    };
    break;
  case "resume":
  case "send":
    body = { jobId, workerId: args[0], text: content,
      ...(action === "resume" && args.includes("--recovery-evidence") ? {recoveryEvidence: JSON.parse(readFileSync(option("--recovery-evidence"), "utf8"))} : {}) };
    break;
  case "stop":
  case "read":
    body = { jobId, workerId: args[0] };
    break;
  case "worker-result":
    body = { workerId: args[0], text: content };
    break;
  case "task-report":
    body = { jobId, status: args[0], text: content };
    break;
  default:
    throw new Error(
      "Usage: cli.ts status | instances | workers | start <stable-key> --file <prompt> | send <worker-id> --file <instructions> | read <worker-id> | worker-result <id> --file <result> | task-report <status> --file <comment>",
    );
}
console.log(JSON.stringify(await control(route, body), null, 2));
