import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record, textField } from "./state.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `Set ${name}; never pass secrets as command-line arguments`,
    );
  return value;
}
const credentialPath = join(homedir(), ".config/codepat/coworker.env");
if (existsSync(credentialPath))
  throw new Error(
    "coworker.env already exists; use the saved credential instead of issuing another key",
  );
const adminKey = required("SOKOSUMI_ADMIN_API_KEY");
const vendorId = required("CODEPAT_VENDOR_ID");
const baseURL = required("CODEPAT_PUBLIC_URL").replace(/\/$/, "");
if (new URL(baseURL).protocol !== "https:")
  throw new Error("CODEPAT_PUBLIC_URL must use HTTPS");
const api = (
  process.env.CODEPAT_API_URL ?? "https://api.sokosumi.com/v1"
).replace(/\/$/, "");
async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}`);
  return record(record(await res.json()).data);
}
// Supply CODEPAT_COWORKER_ID on retries: never duplicate a coworker after an uncertain write.
let id = process.env.CODEPAT_COWORKER_ID;
if (!id) {
  const coworker = await request("/coworkers", "POST", {
    name: "CodePat",
    vendorId,
    baseURL,
    caption: "Your coding orchestrator",
    description:
      "Coordinates concurrent coding agents in Herdr, monitors their progress, and relays your instructions.",
    capabilities: ["chat", "tasks"],
    metadata: { channels: {} },
  });
  id = textField(coworker, "id");
  console.log(
    `Created CodePat coworker ${id}. If a later step fails, rerun with CODEPAT_COWORKER_ID=${id}.`,
  );
} else {
  const coworker = await request(`/coworkers/${encodeURIComponent(id)}`, "GET");
  if (coworker.name !== "CodePat" || record(coworker.vendor).id !== vendorId)
    throw new Error(
      "Existing coworker does not match CodePat and selected vendor",
    );
}
const result = await request(
  `/coworkers/${encodeURIComponent(id)}/api-keys`,
  "POST",
  { name: "CodePat Herdr host" },
);
const token = textField(result, "token");
const dir = join(homedir(), ".config/codepat");
mkdirSync(dir, { recursive: true, mode: 0o700 });
// Separate file preserves any existing host settings. Merge these values into environment locally.
if (/[\r\n]/.test(token) || /[\r\n]/.test(id))
  throw new Error("Invalid credential format");
writeFileSync(
  join(dir, "coworker.env"),
  `CODEPAT_COWORKER_ID=${id}\nCODEPAT_API_KEY=${token}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Coworker credential saved to ~/.config/codepat/coworker.env (mode 600). Configure workspace access/whitelist and Core outbound authentication before enabling chat.",
);
