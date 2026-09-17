# Sokosumi projects and task reassignment

Verified against the public [API reference](https://api.sokosumi.com/) and [live v1 OpenAPI](https://api.sokosumi.com/v1/openapi.json) on 2026-09-17. The docs root advertises `/v1/openapi.json`. No authenticated production task/project data is included here.

| Operation | Contract |
| --- | --- |
| `GET /v1/projects` | Active-workspace projects; `limit` 1–100, `cursor`; `meta.pagination.nextCursor` is null at end |
| `GET /v1/projects/{id}` | Project details; UUID ID |
| `POST /v1/tasks` | Supports `projectId` (UUID or null), `assigneeId`, name, description and initial status |
| `PATCH /v1/tasks/{id}` | Supports `projectId` (UUID or null); updates the existing task |
| `POST /v1/projects/{id}/tasks` | Alternative linking endpoint; explicitly interactive-session-user-only, rejects coworker keys |

The global OpenAPI bearer scheme accepts user credentials and dedicated agent keys. That does **not** mean every operation permits every actor. Project GET and task POST explicitly accept coworker `X-Context-User-Id` and `X-Context-Organization-Id`. The organization header requires a context user who belongs to that organization. Task PATCH does not document context-user headers. The inspected Core source's PATCH handler calls `requireOwnerUserContext`, which rejects agent actors even when they carry a user context. Core also verifies target project and task workspace equality. Source inspection supplements the live schema; it is not a claim of an authenticated PATCH probe against production.

There is no missing live API capability for project listing or task reassignment. The original CodePat launcher omitted `projectId`; its worker scope also intentionally permits only `worker-result`. Reassignment with a coworker key is an upstream authentication restriction, not a reason to use a master token or a database mutation.

## Coordinator selection

Within an active coordinator turn, using its supplied job-scoped configuration:

```sh
node src/cli.ts projects
node src/cli.ts project <project-uuid>
node src/cli.ts start <stable-key> --repo /absolute/repository --base main \
  --kind codex --project <project-uuid> --file /absolute/prompt.md
```

`projects` follows all pages, with a repeated/missing-cursor check and a 1000-page safety cap. It never treats a failed partial listing as complete. `project` confirms membership in that context's list before reading details. The server derives context headers from the active conversation; the caller cannot submit another user's ID or organization. Legacy task conversations without organization metadata fail closed rather than falling back to personal workspace. Newly polled task conversations retain the task organization.

Inspect names, briefings and purpose before choosing an ID. Sokosumi development belongs in the existing Sokosumi development project where accessible. Ambiguous matches require clarification. No fuzzy matching or automatic project creation is implemented. New chat-created tasks require an explicit project UUID; if there is no appropriate accessible project, clarify with the requester rather than silently creating an unassigned task. Existing task intake can retain an already-unassigned task, but the coordinator should report and arrange correction instead of duplicating it.

Selection is validated before reserving a new worker, creating its task, preparing a worktree or launching an agent. A closed/closing project is rejected. Every create includes the selected `projectId`; if the upstream response drops or changes it, CodePat retains the returned task ID but does not launch. Reconcile that task instead of creating a duplicate. A reserved operation retried with a different project fails explicitly. Existing task starts read ownership, organization, assignment and project from the task; an explicit conflicting project is rejected. Follow-ups keep the same task and worker.

Read failures are safe to retry explicitly. Coordinator reads do not retry automatically; a failed inventory aborts creation. A task POST has no upstream idempotency guarantee: an ambiguous create reserves the worker and is not replayed. Stable operation keys refer to the same dispatch within the same job. Inspect existing owned workers on subsequent turns before starting another operation.

## Reassign with the task owner's credential

This is a standalone CLI operation, separate from the bridge and worker reporting credential. It supports organization-owned work for the configured user. Copy `deploy/owner-config.example.json` **outside the repository**, fill in the task owner's user bearer credential, user ID, organization ID and organization slug, and restrict the file to mode 600. Do not supply an agent, admin or vendor credential. User IDs in this local config are expected-identity checks; the API still authenticates the actual user and enforces ownership.

```sh
node src/cli.ts task-project <existing-task-id> --project <verified-project-uuid> \
  --owner-config /absolute/private/owner-config.json
```

This command lists only `scope=owned` tasks in `X-Organization-Slug`, verifies the target task's owner and organization before reading it individually, validates project access, rereads the task, and sends exactly:

```http
PATCH /v1/tasks/<existing-task-id>
Authorization: Bearer <task-owner-user-credential>
X-Organization-Slug: <selected-organization-slug>
Content-Type: application/json

{"projectId":"<verified-project-uuid>"}
```

It then reads the same task to confirm `projectId`. It does not change assignee, title, status, worker ID, worktree or branch. Already-correct assignment succeeds without a write. Reads retry up to twice for 429/502/503/504, with bounded delay; writes never automatically retry. If a PATCH response is lost or rejected, a GET checks whether the desired state was committed. An unconfirmed result fails and requires inspection. Concurrent later edits can still change the project after verification; the API schema exposes no project-specific compare-and-swap precondition. Active schedule conflicts or access failures remain upstream errors, not bypass opportunities. Unassignment and personal workspace mutation are intentionally not provided by this command.

## Coordinator handoff when worker scope is insufficient

During this delivery, a read-only `POST /control/projects` with the supplied worker reporting credential returned HTTP 401 Unauthorized. No project listing or reassignment succeeded, and no master credential was substituted. The two requested existing tasks were **not moved**.

The coordinator should use its authorized project-read context to `GET /v1/projects?limit=100` with the dedicated coworker bearer and the requesting user's context headers, follow `nextCursor`, then `GET /v1/projects/{id}` to verify the matching purpose. It should resolve the setup task ID from the existing owned worker record. For each verified existing task, its owner must use the command above (or the same supported owner-authenticated PATCH), then GET the task to confirm. If matching projects are ambiguous, ask the requester. Concrete private task/worker IDs belong in the worker result, not the source repository.
