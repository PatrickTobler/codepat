#!/usr/bin/env node
// App map and memory for the daily app UX loop.
//   node scripts/ux-map.ts plan <sokosumi-repo> <memory-dir> [count]
// Reads every page route on origin/main, keeps one file per area in <memory-dir>/app-ux/areas/,
// and prints today's areas: stale, changed and important areas first, never one with a PR still open.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = "apps/web/src/app";
const SKIP = new Set([
  "admin", "auth", "oauth", "signin", "signup", "setup", "forgot-password", "reset-password",
  "health", "maintenance", "accept-invitation", "join", "share", "n",
]);
const WEIGHT: Record<string, number> = {
  home: 3, chat: 3, tasks: 3, agents: 3, "soko-bots": 3,
  projects: 2, schedules: 2, drive: 2, connections: 2, "personal-assistant": 2, billing: 2, notifications: 2,
};
const LENSES = [
  "broken things and task completion",
  "empty, loading and error states",
  "phone width (375px)",
  "keyboard and screen reader",
  "copy and clarity",
  "speed and layout stability",
];

type Finding = { id: string; status: "open" | "in-pr" | "merged" | "rejected" | "deferred" };
type Audit = { date: string; task: string; sha: string; lens: string; pr?: number };
type Area = {
  area: string;
  paths: string[];
  routes: string[];
  removedRoutes: string[];
  journeys: unknown[];
  links: unknown[];
  audits: Audit[];
  findings: Finding[];
};

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function currentRoutes(repo: string): Map<string, { routes: Set<string>; paths: Set<string> }> {
  const areas = new Map<string, { routes: Set<string>; paths: Set<string> }>();
  for (const file of git(repo, ["ls-tree", "-r", "--name-only", "origin/main", APP_DIR]).split("\n")) {
    if (!file.endsWith("/page.tsx")) continue;
    const segments = file.slice(APP_DIR.length + 1).split("/").slice(0, -1);
    if (segments.some((s) => s.startsWith("(."))) continue;
    const visible = segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    const area = visible[0] ?? "home";
    if (SKIP.has(area)) continue;
    const rootIndex = visible.length ? segments.indexOf(visible[0]) : segments.length;
    const entry = areas.get(area) ?? { routes: new Set(), paths: new Set() };
    entry.routes.add(`/${visible.join("/")}`);
    entry.paths.add(area === "home" ? file : join(APP_DIR, ...segments.slice(0, rootIndex + 1)));
    areas.set(area, entry);
  }
  return areas;
}

function plan(repo: string, memory: string, count: number): void {
  const dir = join(memory, "app-ux", "areas");
  mkdirSync(dir, { recursive: true });
  const head = git(repo, ["rev-parse", "origin/main"]);
  const today = new Date().toISOString().slice(0, 10);
  const candidates = [];
  const live = currentRoutes(repo);
  const names = new Set([...live.keys(), ...readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))]);
  for (const name of names) {
    const file = join(dir, `${name}.json`);
    const known: Area | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const current = live.get(name);
    const routes = [...(current?.routes ?? [])].sort();
    const area: Area = {
      area: name, journeys: [], links: [], audits: [], findings: [], removedRoutes: [],
      ...known,
      paths: [...(current?.paths ?? known?.paths ?? [])].sort(),
      routes,
    };
    const added = routes.filter((r) => known && !known.routes.includes(r));
    area.removedRoutes = [...new Set([...area.removedRoutes, ...(known?.routes ?? []).filter((r) => !routes.includes(r))])];
    writeFileSync(file, `${JSON.stringify(area, null, 2)}\n`);
    if (!current || area.findings.some((f) => f.status === "in-pr")) continue;
    const last = area.audits.at(-1);
    const days = last ? Math.round((Date.parse(today) - Date.parse(last.date)) / 86_400_000) : 30;
    const range = last?.sha ? [`${last.sha}..origin/main`] : ["--since=30.days", "origin/main"];
    const churn = Number(git(repo, ["rev-list", "--count", ...range, "--", ...area.paths]) || 0);
    const score = (Math.min(days, 30) + 2 * Math.min(churn, 20) + 5 * added.length + (last ? 0 : 20)) * (WEIGHT[name] ?? 1);
    const lens = LENSES[last ? (LENSES.indexOf(last.lens) + 1) % LENSES.length : 0];
    const why = last
      ? `last audited ${days} days ago, ${churn} commits since${added.length ? `, new: ${added.join(", ")}` : ""}`
      : `never audited, ${churn} commits in 30 days`;
    candidates.push({ area: name, score, lens, why, routes, openFindings: area.findings.filter((f) => f.status === "open").length });
  }
  candidates.sort((a, b) => b.score - a.score || a.area.localeCompare(b.area));
  const picked = candidates.slice(0, count);
  writeFileSync(join(memory, "app-ux", `plan-${today}.json`), `${JSON.stringify({ date: today, sha: head, picked, candidates }, null, 2)}\n`);
  console.log(JSON.stringify({ date: today, sha: head, picked }, null, 2));
}

const [command, repo, memory, count] = process.argv.slice(2);
if (command === "plan" && repo && memory) plan(repo, memory, Number(count ?? 3));
else {
  console.error("usage: scripts/ux-map.ts plan <sokosumi-repo> <memory-dir> [count]");
  process.exit(2);
}
