import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record, textField } from "./state.ts";

export function clientConfig(): { url: string; token: string } {
  const path =
    process.env.CODEPAT_CONFIG ??
    join(homedir(), ".local/share/codepat/client.json");
  const config = record(JSON.parse(readFileSync(path, "utf8")));
  return { url: textField(config, "url"), token: textField(config, "token") };
}
export async function control(
  action: string,
  body: unknown = {},
): Promise<unknown> {
  const config = clientConfig();
  const response = await fetch(`${config.url}/control/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      `CodePat control ${action} failed (${response.status}): ${JSON.stringify(result)}`,
    );
  return result;
}
