import { TurnFailure } from "./turn-failure.ts";
import { ClaudeTurn, claudeArgs, FALLBACK_NOTE, shouldFallBack } from "./orchestrator-fallback.ts";
import { CodexProgress, ProgressJournal } from "./progress.ts";
import { turnTimeouts, turnDeadlines, failureKind, failureText, saveReceipt, type TurnReceipt } from "./recovery.ts";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { control } from "./client.ts";
import { Herdr } from "./herdr.ts";
import { record, textField } from "./state.ts";

const exec = promisify(execFile);
// Herdr can start as a system service without a login session's user-bus environment.
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const herdr = new Herdr();
const runnerId = randomUUID();
const timeouts = turnTimeouts();
const pane = process.env.HERDR_PANE_ID;
if (!pane || process.env.HERDR_ENV !== "1")
  throw new Error("CodePat runner must run in a Herdr pane");
let stopping = false;
let activeJob: string | undefined;
let activeUnit: string | undefined;
let activeAttempt = 0;
let turnSettled = false;
let child: ReturnType<typeof spawn> | undefined;
function stopTurn(): void {
  if (!activeJob || !child) return;
  // systemd owns the whole turn process tree, including commands spawned by Codex.
  void exec(
    "systemctl",
    ["--user", "stop", activeUnit!],
    { timeout: 10_000 },
  ).catch(() => console.error("Turn stop unconfirmed; settlement will retry."));
}
async function settleTurn(unit: string): Promise<string> {
  // The systemd-run client can exit while its service still owns live processes.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { stdout } = await exec(
        "systemctl",
        ["--user", "show", unit, "--property=ActiveState,Result,LoadState"],
        { timeout: 10_000 },
      );
      const fields = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
      if (["inactive", "failed"].includes(fields.ActiveState) || fields.LoadState === "not-found") return fields.Result || "unknown";
      await exec("systemctl", ["--user", "stop", unit], { timeout: 10_000 });
    } catch {
      console.error("Turn settlement unconfirmed; retaining the active job.");
    }
    await delay(2000);
  }
  throw new Error("Turn settlement unconfirmed");
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    stopTurn();
  });
// Run one agent CLI as a transient systemd unit that owns its whole process tree.
function runUnit(
  command: string,
  commandArgs: string[],
  env: Record<string, string>,
  limits: ReturnType<typeof turnDeadlines>,
  input: string,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    child = spawn(
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--wait",
        "--pipe",
        `--unit=${activeUnit}`,
        `--property=RuntimeMaxSec=${limits.runtimeSeconds}`,
        `--property=TimeoutStopSec=${limits.stopSeconds}`,
        "--property=KillMode=control-group",
        `--working-directory=${process.cwd()}`,
        ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
        command,
        ...commandArgs,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] },
    );
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        onEvent(record(JSON.parse(line)));
      } catch {
        /* ignore non-protocol progress */
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      stopTurn();
    }, limits.watchdogMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      child = undefined;
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.stdin!.end(input);
  });
}
async function report(state: string): Promise<void> {
  try {
    await herdr.call([
      "pane",
      "report-agent",
      pane!,
      "--source",
      "codepat",
      "--agent",
      "codex",
      "--state",
      state,
      "--message",
      "CodePat orchestrator",
    ]);
  } catch {
    /* monitor reports disconnected Herdr separately */
  }
}
await report("idle");
await herdr.call(["pane", "rename", pane, "CodePat"]);
await herdr.call(["agent", "rename", pane, "codepat"]);
const heartbeat = setInterval(() => {
  void control("heartbeat").catch(() => undefined);
}, 3000);
console.log("CodePat is online.");
while (!stopping) {
  try {
    await report("idle");
    const value = await control("next", { runnerId, protocol: 1 });
    if (!value) {
      await delay(1000);
      continue;
    }
    const next = record(value);
    const job = record(next.job);
    const id = textField(job, "id");
    activeJob = id;
    turnSettled = false;
    const generation = Number(job.generation ?? 0);
    activeAttempt = generation;
    const stem = `${id}.${generation}`;
    activeUnit = `codepat-turn-${stem}.service`;
    const receiptPath = join(process.cwd(), `${stem}.turn.json`);
    const receipt: TurnReceipt = { jobId: id, attempt: generation, launched: false };
    const output = join(process.cwd(), `${stem}.txt`);
    const limits = turnDeadlines(textField(job, "kind"), timeouts);
    const threadId =
      typeof next.threadId === "string" ? next.threadId : undefined;
    const recovery = typeof record(next.context).recoveryNote === "string"
      ? `Recovery reconciliation: ${record(next.context).recoveryNote}\nRetain this response, conversation and task identities. Inspect already completed actions, existing PRs and delivery states before continuing. Never repeat uncertain external actions or override a human approval.\n` : "";
    const prompt = recovery + `You are CodePat. Read AGENTS.md in the current directory. This is request ${id}, kind ${job.kind}. Your tools receive CODEPAT_JOB_ID automatically. Your final response is delivered to this conversation or task.\nContext: ${JSON.stringify(next.context)}\nRequest:\n${job.input}`;
    const args = [
      "exec",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
      ...(threadId ? ["resume", threadId] : []),
      "--skip-git-repo-check",
      "--json",
      "-o",
      output,
      "-",
    ];
    await report("working");
    console.log(`\nCodePat handling ${id} (${job.kind})`);
    const journal = new ProgressJournal(join(process.cwd(), `${stem}.progress.json`));
    // Enable summaries only for the inspected JSONL contract. Other versions
    // still expose assistant commentary and fixed activity labels, never reasoning.
    const codexVersion = await exec("codex", ["--version"], { timeout: 5000 }).catch(() => ({ stdout: "" }));
    const projection = new CodexProgress(item => journal.append({ ...item, key: `${generation}:${item.key}` }), codexVersion.stdout.trim() === "codex-cli 0.154.0");
    const jobClient = record(JSON.parse(await readFile(textField(next, "jobConfig"), "utf8")));
    let progressBusy: Promise<void> | undefined;
    let acknowledged = 0;
    const flushProgress = () => {
      if (progressBusy) return progressBusy;
      progressBusy = (async () => {
        if (acknowledged === journal.items.length) return;
        const items = journal.items.slice();
        const response = await fetch(`${textField(jobClient, "url")}/control/progress`, {
          method: "POST", headers: { Authorization: `Bearer ${textField(jobClient, "token")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: id, items }), signal: AbortSignal.timeout(3000),
        });
        const receipt = record(await response.json());
        if (!response.ok || receipt.ok !== true) throw new Error("Progress not acknowledged");
        acknowledged = items.length;
      })().finally(() => { progressBusy = undefined; });
      return progressBusy;
    };
    const progressTimer = setInterval(() => { void flushProgress().catch(() => undefined); }, 200);
    const protocolFailure = new TurnFailure();
    let newThread: string | undefined;
    let codexActed = false;
    let timedOut = false;
    let exitCode: number;
    let unitResult = "unknown";
    const turnEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => key.startsWith("HERDR_") && value !== undefined,
        ),
      ) as Record<string, string>,
      CODEPAT_JOB_ID: id,
      CODEPAT_CONFIG: textField(next, "jobConfig"),
    };
    try {
      saveReceipt(receiptPath, receipt);
      await control("begin-turn", { jobId: id, runnerId });
      receipt.launched = true;
      saveReceipt(receiptPath, receipt);
      ({ exitCode, timedOut } = await runUnit("codex", args, turnEnv, limits, prompt, (event) => {
        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        )
          { newThread = event.thread_id; receipt.threadId = newThread; saveReceipt(receiptPath, receipt); }
        if (typeof event.type === "string" && event.type.startsWith("item.")) codexActed = true;
        if (event.type === "turn.completed") { receipt.completed = true; saveReceipt(receiptPath, receipt); }
        if (protocolFailure.ingest(event) && protocolFailure.terminal) {
          receipt.failure = protocolFailure.terminal;
          saveReceipt(receiptPath, receipt);
        }
        projection.ingest(event);
        // Print normal progress to this pane, never scrape it as the result channel.
        if (event.type === "item.completed") {
          const item = record(event.item);
          if (
            item.type === "agent_message" &&
            typeof item.text === "string"
          )
            console.log(item.text);
        }
      }));
    } finally {
      clearInterval(progressTimer);
      projection.finish();
      await flushProgress().catch(() => undefined);
      unitResult = await settleTurn(activeUnit);
      turnSettled = true;
    }
    let text = "";
    try {
      text = await readFile(output, "utf8");
    } catch {
      /* failed process may not write a result */
    }
    let error = protocolFailure.resolve(failureKind(unitResult, exitCode, timedOut, stopping, Boolean(text.trim())));
    if (!stopping && shouldFallBack(error, codexActed)) {
      // Same unit name, so the supervisor's liveness check still covers this turn.
      console.log(`Codex unavailable (${error}); handling ${id} with Claude Code.`);
      await exec("systemctl", ["--user", "reset-failed", activeUnit]).catch(() => undefined);
      const claude = new ClaudeTurn();
      // Recovery must see the Claude attempt, not the Codex failure it replaced.
      receipt.failure = undefined;
      receipt.completed = false;
      receipt.fallback = "claude";
      saveReceipt(receiptPath, receipt);
      turnSettled = false;
      try {
        ({ exitCode, timedOut } = await runUnit("claude", claudeArgs({
          conversationId: typeof job.conversationId === "string" ? job.conversationId : undefined,
          cwd: process.cwd(),
        }), turnEnv, limits, FALLBACK_NOTE + prompt, (event) => {
          const message = claude.ingest(event);
          if (message) console.log(message);
          if (claude.text !== undefined) {
            // Write the answer before marking completion so recovery can deliver it.
            writeFileSync(output, claude.text, { mode: 0o600 });
            receipt.completed = true;
            saveReceipt(receiptPath, receipt);
          }
        }));
      } finally {
        unitResult = await settleTurn(activeUnit);
        turnSettled = true;
      }
      text = claude.text ?? "";
      const processFailure = failureKind(unitResult, exitCode, timedOut, stopping, Boolean(text.trim()));
      error = processFailure === "turn_timeout" || processFailure === "turn_interrupted" ? processFailure
        : processFailure || claude.failed ? "fallback_failed" : undefined;
    }
    const completion = {
      jobId: id, attempt: generation,
      text: error ? failureText(error) : text,
      error, threadId: newThread,
    };
    const completionPath = join(process.cwd(), `${stem}.completion.json`);
    saveReceipt(completionPath, completion);
    await exec("systemctl", ["--user", "reset-failed", activeUnit]).catch(() => undefined);
    let delivered = false;
    let threadSaved = !newThread;
    while (!delivered && !stopping) {
      try {
        if (!threadSaved) {
          await control("thread", { jobId: id, threadId: newThread });
          threadSaved = true;
        }
        await flushProgress().catch(() => undefined);
        await control("reply", completion);
        delivered = true;
      } catch {
        console.error("Completion retained locally; retrying bridge delivery.");
        await delay(2000);
      }
    }
    if (!delivered) break;
    activeJob = undefined;
    await unlink(output).catch(() => undefined);
    await unlink(completionPath).catch(() => undefined);
    if (acknowledged === journal.items.length) await unlink(journal.path).catch(() => undefined);
    await unlink(receiptPath).catch(() => undefined);
  } catch (error) {
    console.error("Runner operation failed; private diagnostics remain on the host.");
    if (activeJob && !turnSettled) {
      // Keep the claim/receipts; supervisor must prove the unit dead before recovery.
      stopping = true;
      break;
    }
    if (activeJob) {
      let delivered = false;
      while (!delivered && !stopping) {
        try {
          await control("reply", {
            jobId: activeJob,
            attempt: activeAttempt,
            text: "CodePat encountered a runner error. Durable state remains tracked; check status before retrying.",
            error: "runner_error",
          });
          delivered = true;
        } catch {
          await delay(2000);
        }
      }
      activeJob = undefined;
    }
    await delay(2000);
  }
}
clearInterval(heartbeat);
await report("unknown");
