import { CodexProgress, ProgressJournal } from "./progress.ts";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { control } from "./client.ts";
import { Herdr } from "./herdr.ts";
import { record, textField } from "./state.ts";

const exec = promisify(execFile);
const herdr = new Herdr();
const runnerId = randomUUID();
const pane = process.env.HERDR_PANE_ID;
if (!pane || process.env.HERDR_ENV !== "1")
  throw new Error("CodePat runner must run in a Herdr pane");
let stopping = false;
let activeJob: string | undefined;
let child: ReturnType<typeof spawn> | undefined;
function stopTurn(): void {
  if (!activeJob || !child) return;
  // systemd owns the whole turn process tree, including commands spawned by Codex.
  void exec(
    "systemctl",
    ["--user", "stop", `codepat-turn-${activeJob}.service`],
    { timeout: 10_000 },
  ).catch(() => console.error("Turn stop unconfirmed; settlement will retry."));
}
async function settleTurn(jobId: string): Promise<void> {
  const unit = `codepat-turn-${jobId}.service`;
  // The systemd-run client can exit while its service still owns live processes.
  for (;;) {
    try {
      const { stdout } = await exec(
        "systemctl",
        ["--user", "show", unit, "--property=ActiveState", "--value"],
        { timeout: 10_000 },
      );
      if (["inactive", "failed"].includes(stdout.trim())) return;
      await exec("systemctl", ["--user", "stop", unit], { timeout: 10_000 });
    } catch {
      console.error("Turn settlement unconfirmed; retaining the active job.");
    }
    await delay(2000);
  }
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
    const value = await control("next", { runnerId });
    if (!value) {
      await delay(1000);
      continue;
    }
    const next = record(value);
    const job = record(next.job);
    const id = textField(job, "id");
    activeJob = id;
    const output = join(process.cwd(), `${id}.txt`);
    const threadId =
      typeof next.threadId === "string" ? next.threadId : undefined;
    const prompt = `You are CodePat. Read AGENTS.md in the current directory. This is request ${id}, kind ${job.kind}. Your tools receive CODEPAT_JOB_ID automatically. Finish this turn promptly after dispatching/relaying work; never wait for coding workers. Your final response is delivered to this conversation or task.\nCurrent owned workers and monitor evidence: ${JSON.stringify(next.context)}\nRequest:\n${job.input}`;
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
    const journal = new ProgressJournal(join(process.cwd(), `${id}.progress.json`));
    // Enable summaries only for the inspected JSONL contract. Other versions
    // still expose assistant commentary and fixed activity labels, never reasoning.
    const codexVersion = await exec("codex", ["--version"], { timeout: 5000 }).catch(() => ({ stdout: "" }));
    const projection = new CodexProgress(item => journal.append(item), codexVersion.stdout.trim() === "codex-cli 0.154.0");
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
    let newThread: string | undefined;
    let timedOut = false;
    let exitCode: number;
    try {
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
            "--collect",
            `--unit=codepat-turn-${id}`,
            "--property=RuntimeMaxSec=180",
            "--property=TimeoutStopSec=5",
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
              newThread = event.thread_id;
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
          } catch {
            /* ignore non-protocol progress */
          }
        });
        const timeout = setTimeout(() => {
          timedOut = true;
          stopTurn();
        }, 190_000);
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
      clearInterval(progressTimer);
      projection.finish();
      await flushProgress().catch(() => undefined);
      await settleTurn(id);
    }
    let text = "";
    try {
      text = await readFile(output, "utf8");
    } catch {
      /* failed process may not write a result */
    }
    const error =
      exitCode === 0 && text.trim()
        ? undefined
        : timedOut
          ? "CodePat turn timed out; workers continue running. Check status before retrying."
          : "CodePat turn failed; inspect the orchestrator pane. Workers continue running.";
    const completion = {
      jobId: id,
      text: text || error,
      error,
      threadId: newThread,
    };
    const completionPath = join(process.cwd(), `${id}.completion.json`);
    const temporaryPath = `${completionPath}.${runnerId}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(completion), {
      mode: 0o600,
    });
    await rename(temporaryPath, completionPath);
    let delivered = false;
    let threadSaved = !newThread;
    while (!delivered && !stopping) {
      try {
        if (!threadSaved) {
          await control("thread", { jobId: id, threadId: newThread });
          threadSaved = true;
        }
        await flushProgress();
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
    await unlink(journal.path).catch(() => undefined);
  } catch (error) {
    console.error(String(error));
    if (activeJob) {
      let delivered = false;
      while (!delivered && !stopping) {
        try {
          await control("reply", {
            jobId: activeJob,
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
