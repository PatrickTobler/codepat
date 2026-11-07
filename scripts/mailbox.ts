#!/usr/bin/env node
// Disposable inbox for onboarding runs, backed by the public mail.tm API.
//   node scripts/mailbox.ts create <state.json>              -> prints the new address
//   node scripts/mailbox.ts code <state.json> [timeoutSec]   -> waits for a new 6-digit code and prints it
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const API = "https://api.mail.tm";

async function call(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(API + path, { ...init, headers });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function create(stateFile: string): Promise<void> {
  const domains = await call("/domains");
  const domain = domains["hydra:member"].find((d: any) => d.isActive && !d.isPrivate)?.domain;
  if (!domain) throw new Error("mail.tm has no active public domain");
  const address = `soko-ux-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}@${domain}`;
  const password = randomBytes(18).toString("base64url");
  await call("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const { token } = await call("/token", { method: "POST", body: JSON.stringify({ address, password }) });
  writeFileSync(stateFile, JSON.stringify({ address, password, token, seen: [] }), { mode: 0o600 });
  console.log(address);
}

async function code(stateFile: string, timeoutSec: number): Promise<void> {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const list = await call("/messages", {}, state.token);
    const fresh = list["hydra:member"].filter((m: any) => !state.seen.includes(m.id));
    for (const message of fresh) {
      const full = await call(`/messages/${message.id}`, {}, state.token);
      state.seen.push(message.id);
      writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      const text = `${full.subject ?? ""}\n${full.text ?? ""}\n${(full.html ?? []).join("\n").replace(/<[^>]+>/g, " ")}`;
      const match = text.match(/(?<!\d)\d{6}(?!\d)/);
      if (match) {
        console.log(match[0]);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`no code arrived at ${state.address} within ${timeoutSec}s`);
}

const [command, stateFile, timeout] = process.argv.slice(2);
if (command === "create" && stateFile) await create(stateFile);
else if (command === "code" && stateFile) await code(stateFile, Number(timeout ?? 300));
else {
  console.error("usage: scripts/mailbox.ts create <state.json> | code <state.json> [timeoutSec]");
  process.exit(2);
}
