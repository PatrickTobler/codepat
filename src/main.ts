import { renderOperatingPrompt } from "./operating-prompt.ts";
import { configuredWorkerKinds, availableWorkerKinds } from "./worker-kinds.ts";
import { turnTimeouts, reconcileDeadTurn } from "./recovery.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Herdr, paneFrom, shellQuote } from "./herdr.ts";
import { createCodePatServer } from "./http.ts";
import { Runtime } from "./runtime.ts";
import { type Job, record, State, textField } from "./state.ts";

const allowedWorkerKinds = configuredWorkerKinds(process.env.CODEPAT_WORKER_KINDS);
const turnTimeout = turnTimeouts();
const source = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const dataDir = resolve(
  process.env.CODEPAT_DATA_DIR ?? join(homedir(), ".local/share/codepat"),
);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
function secret(name: string): string {
  const path = join(dataDir, name);
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(path, "utf8").trim();
}
const controlToken = secret("control-token");
const port = Number(process.env.CODEPAT_PORT ?? "3210");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid CODEPAT_PORT");
const state = new State(join(dataDir, "state.sqlite"));
const herdr = new Herdr();
const workerIdleMs = Number(process.env.CODEPAT_WORKER_IDLE_MS ?? 900_000);
if (!Number.isFinite(workerIdleMs) || workerIdleMs < 1000)
  throw new Error("Invalid CODEPAT_WORKER_IDLE_MS");
const repositories = record(
  JSON.parse(process.env.CODEPAT_REPOSITORIES_JSON ?? "{}"),
);
if (Object.values(repositories).some((value) => typeof value !== "string"))
  throw new Error("Repository paths must be strings");
// Advertise only configured providers whose CLI is available on this host.
const workerKinds = await availableWorkerKinds(allowedWorkerKinds, kind =>
  exec(kind, ["--version"], { timeout: 10_000 }).then(() => true, () => false));
const runtime = new Runtime(state, herdr, {
  dataDir,
  cliPath: join(source, "cli.ts"),
  repo: resolve(
    process.env.CODEPAT_REPO ?? join(homedir(), "workspaces/default"),
  ),
  apiUrl: process.env.CODEPAT_API_URL ?? "https://api.sokosumi.com/v1",
  apiKey: process.env.CODEPAT_API_KEY,
  coworkerId: process.env.CODEPAT_COWORKER_ID,
  contactAccountsFile: process.env.CODEPAT_CONTACT_ACCOUNTS_FILE,
  workerIdleMs,
  reviewIntervalMs: process.env.CODEPAT_REVIEW_INTERVAL_MS === undefined ? undefined : Number(process.env.CODEPAT_REVIEW_INTERVAL_MS),
  repositories: repositories as Record<string, string>,
  workerKinds,
});
const server = createCodePatServer({
  organizationId: process.env.CODEPAT_ORGANIZATION_ID ?? "",
  attachmentDirectory: join(dataDir, "attachments"),
  controlToken,
  authorizeControl: (token, action, body) =>
    runtime.authorizeControl(token, action, body),
  service: runtime,
  control: (action, body) => runtime.control(action, body),
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
writeFileSync(
  join(dataDir, "client.json"),
  JSON.stringify({ url: `http://127.0.0.1:${port}`, token: controlToken }),
  { mode: 0o600 },
);
const orchestratorDir = join(dataDir, "orchestrator");
mkdirSync(orchestratorDir, { recursive: true, mode: 0o700 });
writeFileSync(
  join(orchestratorDir, "AGENTS.md"),
  renderOperatingPrompt(join(source, "cli.ts")),
  { mode: 0o600 },
);
let creatingRunner = false;
let startedAt = Date.now();
async function ensureRunner(): Promise<void> {
  if (
    creatingRunner ||
    Date.now() - Math.max(runtime.runnerAt, startedAt) < 15_000
  )
    return;
  creatingRunner = true;
  try {
    let workspace = state.get<string>("meta", "workspace");
    const list = await herdr.call(["workspace", "list"]);
    const workspaces = Array.isArray(list.workspaces)
      ? list.workspaces.map(record)
      : [];
    if (
      !workspace ||
      !workspaces.some((item) => item.workspace_id === workspace)
    ) {
      const created = await herdr.call([
        "workspace",
        "create",
        "--cwd",
        orchestratorDir,
        "--label",
        "CodePat",
        "--no-focus",
      ]);
      workspace = textField(record(created.workspace), "workspace_id");
      state.put("meta", "workspace", workspace);
      state.put("meta", "runnerPane", paneFrom(created));
    }
    let pane = state.get<string>("meta", "runnerPane");
    if (!pane) throw new Error("Missing CodePat runner pane");
    // A stale heartbeat is not permission to launch a second runner in a busy pane.
    const panes = await herdr.call(["pane", "list", "--workspace", workspace]);
    const current = Array.isArray(panes.panes)
      ? panes.panes.map(record).find((item) => item.pane_id === pane)
      : undefined;
    if (!current) {
      const created = await herdr.call([
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        orchestratorDir,
        "--label",
        "CodePat",
        "--no-focus",
      ]);
      pane = paneFrom(created);
      state.put("meta", "runnerPane", pane);
    }
    // pane run only submits after our process inspection confirms an interactive shell (see below).
    const processInfo = record(
      (await herdr.call(["pane", "process-info", "--pane", pane])).process_info,
    );
    const foreground = Array.isArray(processInfo.foreground_processes)
      ? processInfo.foreground_processes.map(record)
      : [];
    const shellReady =
      foreground.length === 1 && foreground[0].pid === processInfo.shell_pid;
    if (!shellReady) {
      console.error(
        "CodePat runner heartbeat is stale; existing pane retained for inspection.",
      );
      return;
    }
    for (const job of state.all<Job>("jobs")) {
      if (job.status === "in_progress") {
        const stem = job.reservationProtocol === 1 ? `${job.id}.${job.generation ?? 0}` : job.id;
        const { stdout } = await exec("systemctl", ["--user", "show", `codepat-turn-${stem}.service`, "--property=ActiveState,LoadState"]);
        const fields = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
        if (!["inactive", "failed"].includes(fields.ActiveState) && fields.LoadState !== "not-found") {
          console.error("Previous turn is still supervised; no replacement runner launched.");
          return;
        }
        reconcileDeadTurn(runtime, orchestratorDir, job.id, {
          runnerGone: shellReady, activeState: fields.ActiveState, loadState: fields.LoadState,
        });
      }
    }
    const command = `CODEPAT_CHAT_TIMEOUT_MS=${turnTimeout.chatMs} CODEPAT_BACKGROUND_TIMEOUT_MS=${turnTimeout.backgroundMs} CODEPAT_CONFIG=${shellQuote(join(dataDir, "client.json"))} ${shellQuote(process.execPath)} ${shellQuote(join(source, "runner.ts"))}`;
    await herdr.call(["pane", "run", pane, command]);
    startedAt = Date.now();
  } finally {
    creatingRunner = false;
  }
}
const timers: NodeJS.Timeout[] = [];
function loop(ms: number, action: () => Promise<void>): void {
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      await action();
    } catch (error) {
      console.error(String(error));
    } finally {
      active = false;
    }
  };
  timers.push(
    setInterval(() => {
      void tick();
    }, ms),
  );
  void tick();
}
loop(3000, async () => {
  await runtime.monitor();
  await runtime.recoverWorkers();
  await runtime.cleanupWorkers();
});
loop(2000, () => runtime.deliver());
loop(2000, () => runtime.contacts.deliver());
loop(5000, () => runtime.pollTasks());
loop(5000, () => runtime.flushOutbox());
loop(10_000, async () => {
  runtime.reviews.schedule(Date.now());
  await ensureRunner();
});
startedAt = 0;
await ensureRunner();
console.log(
  `CodePat bridge listening on 127.0.0.1:${port}. Task intake ${runtime.config.apiKey && runtime.config.coworkerId ? "enabled" : "not configured"}.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const timer of timers) clearInterval(timer);
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  });
