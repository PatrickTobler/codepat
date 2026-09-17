import { setTimeout as delay } from "node:timers/promises";
import { record, textField } from "./state.ts";

export type Api = (path: string, method?: string, body?: unknown,
  headers?: Record<string, string>) => Promise<Record<string, unknown>>;

export function projectId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error("A project UUID is required; inspect accessible projects first");
  return value;
}

// Never return a partial inventory as if it were complete.
export async function pages(api: Api, path: string, headers: Record<string, string>) {
  const items: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    const response = await api(`${path}${path.includes("?") ? "&" : "?"}${query}`, "GET", undefined, headers);
    if (!Array.isArray(response.data)) throw new Error("Invalid paginated API response");
    items.push(...response.data.map(record));
    const next = record(record(response.meta).pagination).nextCursor;
    if (next === null) return items;
    if (typeof next !== "string" || !next || cursors.has(next))
      throw new Error("Invalid or repeated pagination cursor");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("Pagination safety limit exceeded; inventory incomplete");
}

export async function inspectProject(api: Api, id: string, headers: Record<string, string>) {
  projectId(id);
  // Membership in the context-filtered list is required, even if a detail endpoint
  // can expose a project via some other grant.
  if (!(await pages(api, "/projects", headers)).some(p => p.id === id))
    throw new Error("Project is not accessible in the requesting workspace");
  const project = record((await api(`/projects/${encodeURIComponent(id)}`, "GET", undefined, headers)).data);
  if (project.id !== id || project.closedAt || project.closingAt)
    throw new Error("Project is unavailable or closing");
  return project;
}

export function userApi(config: Record<string, unknown>): Api {
  const token = textField(config, "token");
  if (/^(coworker_|sokoBot_)/.test(token))
    throw new Error("Task reassignment requires the task owner's user credential, not an agent key");
  const base = new URL(typeof config.apiUrl === "string" ? config.apiUrl : "https://api.sokosumi.com/v1");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("Owner credentials require HTTPS");
  return async (path, method = "GET", body, headers = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(base.href.replace(/\/$/, "") + path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (method === "GET" && attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
        await delay(Math.min(5000, Math.max(250 * 2 ** attempt, Number(response.headers.get("retry-after") ?? 0) * 1000)));
        continue;
      }
      if (!response.ok) throw new Error(`Sokosumi ${method} ${path.split("?")[0]} returned ${response.status}; no automatic write retry`);
      return record(await response.json());
    }
  };
}

export async function reassignOwnedTask(api: Api, config: Record<string, unknown>, taskId: string, target: string) {
  projectId(target);
  const userId = textField(config, "userId");
  const organizationId = textField(config, "organizationId");
  const headers = { "X-Organization-Slug": textField(config, "organizationSlug") };
  // List only owned tasks before reading an individual task. Core still enforces
  // owner authentication and project workspace equality at PATCH time.
  const owned = (await pages(api, "/tasks?scope=owned", headers)).find(t => t.id === taskId);
  const check = (t: Record<string, unknown>) => {
    if (t.id !== taskId || (t.ownerId ?? t.userId) !== userId || t.organizationId !== organizationId)
      throw new Error("Task is not owned by the configured user in this organization");
  };
  if (!owned) throw new Error("Task not found in owned tasks; no mutation attempted");
  check(owned);
  await inspectProject(api, target, headers);
  const path = `/tasks/${encodeURIComponent(taskId)}`;
  const before = record((await api(path, "GET", undefined, headers)).data);
  check(before);
  if (before.projectId === target) return { taskId, projectId: target, changed: false, verified: true };
  try {
    await api(path, "PATCH", { projectId: target }, headers);
  } catch (error) {
    // A lost response may follow a committed PATCH. Reconcile by reading; never
    // repeat a write automatically or overwrite another actor's subsequent edit.
    const after = record((await api(path, "GET", undefined, headers)).data);
    check(after);
    if (after.projectId !== target) throw error;
    return { taskId, projectId: target, changed: true, verified: true, reconciled: true };
  }
  const after = record((await api(path, "GET", undefined, headers)).data);
  check(after);
  if (after.projectId !== target) throw new Error("Project update not confirmed; inspect before retrying");
  return { taskId, projectId: target, changed: true, verified: true };
}
