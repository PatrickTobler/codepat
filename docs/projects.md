# Sokosumi projects

The coordinator can list projects with `node src/cli.ts projects` and inspect one with `node src/cli.ts project <uuid>`. Both operations are bound to the active turn's stored user and organization context. Pagination follows every cursor and refuses malformed loops.

Project reads use the dedicated coworker key. Existing task reassignment is different: Sokosumi requires the task owner's user credential. CodePat therefore keeps `task-project` as an explicit standalone command using a private owner configuration file:

```sh
node src/cli.ts task-project <task-id> --project <project-id> --owner-config /private/owner.json
```

The command verifies the authenticated user, organization, task ownership, target project access and final task state. Safe reads have bounded retries. A project PATCH is never replayed blindly; after an ambiguous response the command reads the task to determine whether the requested project was committed.

Keep the owner configuration outside the repository with mode `0600`. Never substitute an admin/vendor credential or place it in an agent prompt. Project selection and reassignment live in Sokosumi; CodePat stores no project or worker lifecycle of its own.
