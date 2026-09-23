import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { record, textField } from "./state.ts";

const exec = promisify(execFile);
export interface Agent {
  pane_id: string;
  agent_status: string;
  cwd?: string;
  name?: string;
  agent_name?: string;
  agent?: string;
  terminal_title?: string;
  agent_session_id?: string;
}
export interface HerdrPort {
  call(args: string[]): Promise<Record<string, unknown>>;
  agents(): Promise<Agent[]>;
  prompt(target: string, input: string): Promise<void>;
}
export class Herdr implements HerdrPort {
  async call(args: string[]): Promise<Record<string, unknown>> {
    const { stdout } = await exec("herdr", args, {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (args[1] === "read" && ["agent", "pane"].includes(args[0]))
      return { text: stdout };
    if (!stdout.trim()) return {};
    const envelope = record(JSON.parse(stdout));
    if (envelope.error)
      throw new Error(`Herdr: ${JSON.stringify(envelope.error)}`);
    return record(envelope.result);
  }
  async agents(): Promise<Agent[]> {
    const result = await this.call(["agent", "list"]);
    if (!Array.isArray(result.agents))
      throw new Error("Herdr returned no agent list");
    return result.agents.map((value) => {
      const item = record(value);
      return {
        pane_id: textField(item, "pane_id"),
        agent_session_id: typeof item.agent_session_id === "string" ? item.agent_session_id : undefined,
        agent_status: textField(item, "agent_status"),
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        agent_name:
          typeof item.agent_name === "string" ? item.agent_name : undefined,
        agent: typeof item.agent === "string" ? item.agent : undefined,
        terminal_title:
          typeof item.terminal_title === "string"
            ? item.terminal_title
            : undefined,
      };
    });
  }
  async prompt(target: string, input: string): Promise<void> {
    // No --wait: coding workers continue concurrently after prompt submission.
    await this.call(["agent", "prompt", target, input]);
  }
}
export async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
export function paneFrom(result: Record<string, unknown>): string {
  return textField(record(result.root_pane ?? result.pane), "pane_id");
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
