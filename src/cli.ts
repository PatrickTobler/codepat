#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { reassignOwnedTask, userApi } from "./projects.ts";
import { record } from "./state.ts";
import { control } from "./client.ts";

const [action, ...args] = process.argv.slice(2);
if (action === "--help" || action === "help" || !action) {
  console.log(`CodePat (Node 24)
status | repositories | instances | projects | project <uuid>
task-status [task-id]
task-create --project <uuid> --name <name> --description-file <path>
task-recover <task-id> (owner/admin recovery; not available to a scoped turn)
task-report <status> --file <comment.md>
task-runtime list
task-runtime attach --kind <herdr|external> --id <resource> --role <role>
task-runtime detach --kind <herdr|external> --id <resource>
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
if (action === "task-recover") {
  console.log(JSON.stringify(await control(action, { taskId: args[0] }), null, 2));
  process.exit(0);
}
const jobId = process.env.CODEPAT_JOB_ID;
let body: Record<string, unknown> = { jobId };
switch (action) {
  case "status":
  case "projects":
  case "repositories":
  case "instances":
    break;
  case "task-status":
    body = { jobId, ...(args[0] ? { taskId: args[0] } : {}) };
    break;
  case "project":
    body = { jobId, projectId: args[0] };
    break;
  case "task-report":
    body = { jobId, status: args[0], text: readFileSync(option("--file"), "utf8") };
    break;
  case "task-create":
    body = { jobId, projectId: option("--project"), name: option("--name"), description: readFileSync(option("--description-file"), "utf8") };
    break;
  case "task-runtime":
    body = {
      jobId,
      operation: args[0],
      ...(args[0] === "list" ? {} : { kind: option("--kind"), resourceId: option("--id") }),
      ...(args[0] === "attach" ? { role: option("--role") } : {}),
    };
    break;
  default:
    throw new Error(
      "Usage: cli.ts status | repositories | instances | projects | project <uuid> | task-status [task-id] | task-report <status> --file <comment.md>",
    );
}
console.log(JSON.stringify(await control(action, body), null, 2));
