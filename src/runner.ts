import { chatTimeoutMs, deadlines, failureKind, failureText, saveReceipt, type TurnReceipt } from "./recovery.ts";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const chatDeadline = chatTimeoutMs(process.env.CODEPAT_CHAT_TIMEOUT_MS ?? 600_000);
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
console.log(
  "CodePat is online. Concurrent worker monitoring runs independently in the bridge.",
);
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
    const limits = deadlines(job.kind === "chat" ? chatDeadline : 180_000);
    const threadId =
      typeof next.threadId === "string" ? next.threadId : undefined;
    const recovery = typeof record(next.context).recoveryNote === "string"
      ? `Recovery reconciliation: ${record(next.context).recoveryNote}\nRetain this response, conversation, task and worker identities. Inspect already completed actions, worker keys, existing PRs and delivery states before continuing. Never repeat uncertain external actions or override a human approval.\n` : "";
    const prompt = recovery + `You are CodePat. Read AGENTS.md in the current directory. This is request ${id}, kind ${job.kind}. Your tools receive CODEPAT_JOB_ID automatically. Finish this turn promptly after dispatching/relaying work; never wait for coding workers. Your final response is delivered to this conversation or task.\nCurrent owned workers and monitor evidence: ${JSON.stringify(next.context)}\nRequest:\n${job.input}`;
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
    let newThread: string | undefined;
    let timedOut = false;
    let exitCode: number;
    let unitResult = "unknown";
    try {
      saveReceipt(receiptPath, receipt);
      await control("begin-turn", { jobId: id, runnerId });
      receipt.launched = true;
      saveReceipt(receiptPath, receipt);
      exitCode = await new Promise<number>((resolve, reject) => {
        const turnEnv = {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key, value]) => key.startsWith("HERDR_") && value !== undefined,
            ),
          ),
          CODEPAT_JOB_ID: id,
          CODEPAT_CONFIG: textField(next, "jobConfig"),
        };
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
            ...Object.entries(turnEnv).map(
              ([key, value]) => `--setenv=${key}=${value}`,
            ),
            "codex",
            ...args,
          ],
          {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "inherit"],
          },
        );
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          try {
            const event = record(JSON.parse(line));
            if (
              event.type === "thread.started" &&
              typeof event.thread_id === "string"
            )
              { newThread = event.thread_id; receipt.threadId = newThread; saveReceipt(receiptPath, receipt); }
            if (event.type === "turn.completed") { receipt.completed = true; saveReceipt(receiptPath, receipt); }
            // Print normal progress to this pane, never scrape it as the result channel.
            if (event.type === "item.completed") {
              const item = record(event.item);
              if (
                item.type === "agent_message" &&
                typeof item.text === "string"
              )
                console.log(item.text);
            }
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
          resolve(code ?? 1);
        });
        child.stdin!.end(prompt);
      });
    } finally {
      unitResult = await settleTurn(activeUnit);
      turnSettled = true;
    }
    let text = "";
    try {
      text = await readFile(output, "utf8");
    } catch {
      /* failed process may not write a result */
    }
    const error = failureKind(unitResult, exitCode, timedOut, stopping, Boolean(text.trim()));
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
            text: "CodePat encountered a runner error. Existing workers remain tracked; check status before retrying.",
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
