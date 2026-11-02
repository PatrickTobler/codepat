import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// A turn runs in a supervisor that owns its whole process tree: a transient systemd unit on Linux,
// a detached process group tracked by a pid file on macOS.
const exec = promisify(execFile);
const darwin = process.platform === "darwin";
export type UnitLimits = { runtimeSeconds: number; stopSeconds: number };
export type UnitState = { activeState: string; loadState: string; result: string };
const results = new Map<string, string>();
const pidFile = (dir: string, unit: string) => join(dir, `${unit}.pgid`);

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function readPgid(dir: string, unit: string): number | undefined {
  try {
    const pgid = Number(readFileSync(pidFile(dir, unit), "utf8"));
    return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch {
    return undefined;
  }
}
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}
function killGroup(pgid: number, stopSeconds: number): void {
  signalGroup(pgid, "SIGTERM");
  setTimeout(() => signalGroup(pgid, "SIGKILL"), stopSeconds * 1000).unref();
}

export function startUnit(unit: string, cwd: string, command: string, args: string[], env: Record<string, string>, limits: UnitLimits): ChildProcess {
  if (!darwin)
    return spawn("systemd-run", [
      "--user", "--quiet", "--wait", "--pipe", `--unit=${unit}`,
      `--property=RuntimeMaxSec=${limits.runtimeSeconds}`,
      `--property=TimeoutStopSec=${limits.stopSeconds}`,
      "--property=KillMode=control-group",
      `--working-directory=${cwd}`,
      ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
      command, ...args,
    ], { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["pipe", "pipe", "inherit"] });
  const pgid = child.pid;
  if (!pgid) return child;
  writeFileSync(pidFile(cwd, unit), String(pgid), { mode: 0o600 });
  results.set(unit, "running");
  const runtime = setTimeout(() => {
    results.set(unit, "timeout");
    killGroup(pgid, limits.stopSeconds);
  }, limits.runtimeSeconds * 1000);
  child.once("exit", (code, signal) => {
    clearTimeout(runtime);
    if (results.get(unit) === "running") results.set(unit, signal ? "signal" : code === 0 ? "success" : "exit-code");
  });
  return child;
}

export async function stopUnit(unit: string, cwd: string, stopSeconds = 10): Promise<void> {
  if (!darwin) {
    await exec("systemctl", ["--user", "stop", unit], { timeout: 10_000 });
    return;
  }
  const pgid = readPgid(cwd, unit);
  if (pgid) killGroup(pgid, stopSeconds);
}

export async function unitState(unit: string, cwd: string): Promise<UnitState> {
  if (!darwin) {
    const { stdout } = await exec("systemctl", ["--user", "show", unit, "--property=ActiveState,Result,LoadState"], { timeout: 10_000 });
    const fields = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
    return { activeState: fields.ActiveState ?? "", loadState: fields.LoadState ?? "", result: fields.Result || "unknown" };
  }
  const pgid = readPgid(cwd, unit);
  if (!pgid) return { activeState: "inactive", loadState: "not-found", result: results.get(unit) ?? "unknown" };
  const alive = groupAlive(pgid);
  const result = results.get(unit);
  return { activeState: alive ? "active" : "inactive", loadState: "loaded", result: !result || result === "running" ? "unknown" : result };
}

export async function resetUnit(unit: string, cwd: string): Promise<void> {
  if (!darwin) {
    await exec("systemctl", ["--user", "reset-failed", unit]).catch(() => undefined);
    return;
  }
  const pgid = readPgid(cwd, unit);
  if (pgid && groupAlive(pgid)) return;
  rmSync(pidFile(cwd, unit), { force: true });
  results.delete(unit);
}
