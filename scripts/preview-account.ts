#!/usr/bin/env node
// Moves a real account onto a disposable inbox inside one PR's mainnet preview database (a Neon copy of production).
//   node scripts/preview-account.ts adopt <pr-number> <real-email> <inbox-email>
// Only the branch-scoped DATABASE_URL_UNPOOLED that the Preview deploy workflow wrote for that open PR is used.
// Every other user's email in that copy is replaced too, so nothing the preview sends reaches a real person.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const REPO = "masumi-network/sokosumi";
const CORE_PROJECT = "sokosumi-core-mainnet";
const TEAM_SLUG = "masumi";
const PSQL = "/opt/homebrew/opt/libpq/bin/psql";
const EMAIL = /^[^\s'"\\;]+@[^\s'"\\;]+$/;

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function vercelToken(): string {
  execFileSync("npx", ["-y", "vercel@latest", "whoami"], { stdio: "ignore" });
  const auth = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/com.vercel.cli/auth.json`, "utf8"));
  return auth.token;
}

async function vercel(path: string, token: string): Promise<any> {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`https://api.vercel.com${path}${separator}slug=${TEAM_SLUG}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Vercel ${path.split("?")[0]}: HTTP ${response.status}`);
  return response.json();
}

async function previewDatabaseUrl(pr: number): Promise<string> {
  const { state, headRefName } = JSON.parse(gh(["pr", "view", String(pr), "-R", REPO, "--json", "state,headRefName"]));
  if (state !== "OPEN") throw new Error(`PR #${pr} is ${state}`);
  const repoId = gh(["api", `repos/${REPO}`, "-q", ".id"]);
  const owner = `GitHub-managed preview/gh-${repoId}-pr-${pr}`;
  const token = vercelToken();
  const { envs } = await vercel(`/v10/projects/${CORE_PROJECT}/env?gitBranch=${encodeURIComponent(headRefName)}`, token);
  const env = envs.find(
    (e: any) =>
      e.key === "DATABASE_URL_UNPOOLED" &&
      e.comment === owner &&
      e.gitBranch === headRefName &&
      e.target?.length === 1 &&
      e.target[0] === "preview",
  );
  if (!env) throw new Error(`No preview database for PR #${pr}; comment /deploy mainnet first`);
  const { value } = await vercel(`/v1/projects/${CORE_PROJECT}/env/${env.id}`, token);
  return value;
}

function psql(url: string, sql: string): string {
  const u = new URL(url);
  return execFileSync(PSQL, ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: u.pathname.slice(1),
      PGSSLMODE: "require",
    },
  }).trim();
}

async function adopt(pr: number, realEmail: string, inbox: string): Promise<void> {
  if (!EMAIL.test(realEmail) || !EMAIL.test(inbox)) throw new Error("invalid email");
  const url = await previewDatabaseUrl(pr);
  psql(
    url,
    `DO $$ DECLARE n int; BEGIN
  UPDATE "user" SET email = '${inbox}', "emailVerified" = true, "updatedAt" = now() WHERE lower(email) = lower('${realEmail}');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected one account for ${realEmail}, found %', n; END IF;
  UPDATE "user" SET email = 'user-' || id || '@example.invalid'
    WHERE lower(email) <> lower('${inbox}') AND email NOT LIKE '%@example.invalid';
END $$;`,
  );
  console.log(`PR #${pr} preview: ${realEmail} now signs in as ${inbox}; other users' emails replaced`);
}

const [command, pr, realEmail, inbox] = process.argv.slice(2);
if (command === "adopt" && Number(pr) > 0 && realEmail && inbox) await adopt(Number(pr), realEmail, inbox);
else {
  console.error("usage: scripts/preview-account.ts adopt <pr-number> <real-email> <inbox-email>");
  process.exit(2);
}
