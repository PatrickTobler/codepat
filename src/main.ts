import { renderOperatingPrompt } from "./operating-prompt.ts";
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
import { Runtime, runnerSlot } from "./runtime.ts";
import { type Job, record, State, textField } from "./state.ts";

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
const runnerSlots = Number(process.env.CODEPAT_RUNNERS ?? "3");
if (!Number.isInteger(runnerSlots) || runnerSlots < 1 || runnerSlots > 8)
  throw new Error("CODEPAT_RUNNERS must be an integer from 1 to 8");
const state = new State(join(dataDir, "state.sqlite"));
const herdr = new Herdr();
const repositories = record(
  JSON.parse(process.env.CODEPAT_REPOSITORIES_JSON ?? "{}"),
);
if (Object.values(repositories).some((value) => typeof value !== "string"))
  throw new Error("Repository paths must be strings");
const runtime = new Runtime(state, herdr, {
  dataDir,
  cliPath: join(source, "cli.ts"),
  repo: resolve(
    process.env.CODEPAT_REPO ?? join(homedir(), "workspaces/default"),
  ),
  apiUrl: process.env.CODEPAT_API_URL ?? "https://api.sokosumi.com/v1",
  apiKey: process.env.CODEPAT_API_KEY,
  coworkerId: process.env.CODEPAT_COWORKER_ID,
  repositories: repositories as Record<string, string>,
  runnerSlots,
});
const server = createCodePatServer({
  organizationId: process.env.CODEPAT_ORGANIZATION_ID ?? "",
  ownerId: process.env.CODEPAT_OWNER_ID,
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
const startedAt = new Map<number, number>();
// Slot 0 keeps the original pane key so existing installs reuse their runner pane.
const paneKey = (slot: number) => (slot === 0 ? "runnerPane" : `runnerPane:${slot}`);
async function ensureRunners(): Promise<void> {
  if (creatingRunner) return;
  creatingRunner = true;
  try {
    for (let slot = 0; slot < runnerSlots; slot++) await ensureRunner(slot);
  } finally {
    creatingRunner = false;
  }
}
async function ensureRunner(slot: number): Promise<void> {
  if (Date.now() - Math.max(runtime.runnerSeenAt(slot), startedAt.get(slot) ?? 0) < 15_000)
    return;
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
    state.put("meta", paneKey(slot), paneFrom(created));
  }
  // A slot added after install has no pane yet; it gets a new tab below.
  let pane = state.get<string>("meta", paneKey(slot));
  // A stale heartbeat is not permission to launch a second runner in a busy pane.
  const panes = await herdr.call(["pane", "list", "--workspace", workspace]);
  const current = Array.isArray(panes.panes)
    ? panes.panes.map(record).find((item) => item.pane_id === pane)
    : undefined;
  if (!current || !pane) {
    const created = await herdr.call([
      "tab",
      "create",
      "--workspace",
      workspace,
      "--cwd",
      orchestratorDir,
      "--label",
      slot ? `CodePat ${slot + 1}` : "CodePat",
      "--no-focus",
    ]);
    pane = paneFrom(created);
    state.put("meta", paneKey(slot), pane);
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
    if (job.status === "in_progress" && runnerSlot(state.get<string>("claims", job.id)) === slot) {
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
  const command = `CODEPAT_RUNNER_SLOT=${slot} CODEPAT_CHAT_TIMEOUT_MS=${turnTimeout.chatMs} CODEPAT_BACKGROUND_TIMEOUT_MS=${turnTimeout.backgroundMs} CODEPAT_CONFIG=${shellQuote(join(dataDir, "client.json"))} ${shellQuote(process.execPath)} ${shellQuote(join(source, "runner.ts"))}`;
  await herdr.call(["pane", "run", pane, command]);
  startedAt.set(slot, Date.now());
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
loop(5000, () => runtime.pollTasks());
loop(5000, () => runtime.pollTaskRuntimes());
loop(5000, () => runtime.flushOutbox());
loop(60_000, () => runtime.reconcileTasks());
loop(300_000, async () => {
  const storage = runtime.storageHealth();
  if (storage.low) console.error(`Low disk space: ${storage.availableBytes} bytes available in CodePat data filesystem`);
});
loop(10_000, () => ensureRunners());
await ensureRunners();
console.log(
  `CodePat bridge listening on 127.0.0.1:${port}. Task intake ${runtime.config.apiKey && runtime.config.coworkerId ? "enabled" : "not configured"}.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const timer of timers) clearInterval(timer);
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  });
