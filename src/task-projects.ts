import { inspectProject, pages, projectId, type Api } from "./projects.ts";
import { record, type Worker } from "./state.ts";

export interface TaskProjectRow {
  taskId: string;
  workerIds: string[];
  repositories: string[];
  cached: { workerId: string; projectId?: string; unconfirmed: boolean }[];
  live: { verified: false; error: string } | {
    verified: true; title: string; projectId: string | null;
    projectState: "available" | "closed" | "inaccessible" | "unverified" | "unassigned";
    cacheState: "matches" | "differs" | "unknown" | "unconfirmed";
    expectedMatch?: boolean;
  };
}
// Caller supplies only locally owned tracked workers, never arbitrary task IDs.
// This inventory is read-only: remote truth must not overwrite an unconfirmed
// create reservation or imply permission to move a task to a guessed project.
export async function auditTaskProjects(api: Api, workers: Worker[], scope: {
  userId: string; organizationId: string;
}, expectedProject?: string) {
  const headers = { "X-Context-User-Id": scope.userId, "X-Context-Organization-Id": scope.organizationId };
  if (!scope.userId || !scope.organizationId) throw new Error("Known requester and organization are required");
  if (expectedProject) await inspectProject(api, expectedProject, headers);
  const groups = new Map<string, Worker[]>();
  for (const worker of workers) {
    if (!worker.taskId) continue;
    groups.set(worker.taskId, [...(groups.get(worker.taskId) ?? []), worker]);
  }
  let accessible: Set<string> | undefined;
  try { accessible = new Set((await pages(api, "/projects", headers)).map(p => String(p.id))); }
  catch { /* Mark project visibility unverified; never treat a partial list as complete. */ }
  const projectStates = new Map<string, "available" | "closed" | "inaccessible" | "unverified">();
  const rows: TaskProjectRow[] = [];
  for (const [taskId, group] of groups) {
    const row: TaskProjectRow = {
      taskId, workerIds: group.map(w => w.id), repositories: [...new Set(group.map(w => w.repo))],
      cached: group.map(w => ({ workerId: w.id, projectId: w.projectId, unconfirmed: Boolean(w.projectUnconfirmed) })),
      live: { verified: false, error: "task_read_failed" },
    };
    try {
      const task = record((await api(`/tasks/${encodeURIComponent(taskId)}`, "GET", undefined, headers)).data);
      if (task.id !== taskId || (task.ownerId ?? task.userId) !== scope.userId || task.organizationId !== scope.organizationId) {
        row.live = { verified: false, error: "ownership_or_workspace_changed" };
        rows.push(row); continue; // Do not disclose another owner's returned title/project.
      }
      if (!Object.hasOwn(task, "projectId")) throw new Error("Missing project field");
      const liveProject = task.projectId === null ? null : projectId(task.projectId);
      if (liveProject && !projectStates.has(liveProject)) {
        let status: "available" | "closed" | "inaccessible" | "unverified" = "unverified";
        if (accessible && !accessible.has(liveProject)) status = "inaccessible";
        else if (accessible) {
          try {
            const p = record((await api(`/projects/${encodeURIComponent(liveProject)}`, "GET", undefined, headers)).data);
            if (p.id === liveProject) status = p.closedAt || p.closingAt ? "closed" : "available";
          } catch { /* Directory access alone does not verify current detail. */ }
        }
        projectStates.set(liveProject, status);
      }
      row.live = {
        verified: true, title: typeof task.name === "string" ? task.name.slice(0, 300) : "",
        projectId: liveProject, projectState: liveProject ? projectStates.get(liveProject)! : "unassigned",
        cacheState: group.some(w => w.projectUnconfirmed) ? "unconfirmed" : group.some(w => w.projectId !== undefined && w.projectId !== liveProject) ? "differs" : group.some(w => w.projectId === undefined) ? "unknown" : "matches",
        ...(expectedProject ? { expectedMatch: liveProject === expectedProject } : {}),
      };
    } catch { row.live = { verified: false, error: "task_read_failed_or_invalid_response" }; }
    rows.push(row);
  }
  return { observedAt: Date.now(), uniqueTasks: rows.length, expectedProject,
    complete: Boolean(accessible) && rows.every(r => r.live.verified && r.live.projectState !== "unverified"),
    projectInventoryVerified: Boolean(accessible), rows };
}
