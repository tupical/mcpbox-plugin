---
description: Show who and where you are on mcpbox — workspace, account, this repo's project — plus server and pipeline health.
---

The user invoked `/mcpbox:status`.

## Steps

1. `daruma_healthz` — if it fails, report "mcpbox unreachable" and how to start the
   server; stop (do not fall back to `.omc/plans/` or markdown).
2. `daruma_workspace_info` — one call carries most of the answer:
   - `workspace.slug` / `workspace.title` — the authorized workspace;
   - `account.email` — who this MCP session is authenticated as;
   - `scopes[]` — repo→project bindings; match the current working directory
     against `scope` (longest matching prefix wins, since repos nest) to find
     this repo's `project_id`.
   - Self-hosted installs have no cloud account, so `workspace` and `account`
     may be absent. Omit the line entirely — never print `null` or a bare UUID.
3. Resolve the project **title** for that `project_id` via `daruma_project_list`
   (the `name` inside `scopes` is only the directory basename, not the project's
   title). Skip if the cwd matches no scope.
4. One scoped `daruma_list status=active` → count open tasks (do not enumerate
   the archive).
5. `mcpbox_runs_list` with `limit=5` (and `status=failed` if the user asked about
   failures) → recent pipeline runs.
6. Render, dropping any line whose value is unknown:

   ```
   ## mcpbox status
   workspace: <title> (<slug>)
   account:   <email>
   project:   <project title> — <repo path>
   open:      <N> tasks
   server:    ok (v<version>, sha <git_sha>)
   runs:      <run_id> <status> · <run_id> <status> …
   ```

   Identity first: "which workspace am I in, as whom, on what project" is the
   question this command exists to answer; server health is the footnote.

7. Read-only.
