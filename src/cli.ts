#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { reassignOwnedTask, userApi } from "./projects.ts";
import { record } from "./state.ts";
import { control } from "./client.ts";

const [action, ...args] = process.argv.slice(2);
if (action === "--help" || action === "help" || !action) {
  console.log(`CodePat (Node 24)
review-status | review-work <worker> --state pending|waiting|done --file <note>
recover-chat <response-id> --reconciled --file <reconciliation>
status | repositories | instances | workers | projects | project <uuid>
contacts <name-or-email>
dm-send <stable-key> (--to <name-or-email> | --recipient <verified-user-id>) [--room <uuid>] [--coordination <authorized-task-purpose>] --file <message>
dm-status <stable-key> | dm-retry <stable-key>
start <stable-key> --file <prompt> --project <uuid> [--repo <path>] [--base <branch>] [--kind codex|claude]
send|resume <worker> --file <instructions> | stop|read <worker>
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
    body = { jobId, workerId: args[0], text: content };
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
