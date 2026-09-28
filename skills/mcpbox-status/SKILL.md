---
name: mcpbox-status
description: Show who and where you are on mcpbox — workspace, account, this repo's project — plus server and pipeline health.
---

The user invoked `/mcpbox:status`.

## Steps

1. `daruma_workspace_info` — one call carries most of the answer. If it fails
   with a transport error, report "mcpbox unreachable" and how to start the
   server; stop (do not fall back to local plan files or markdown). No separate
   health probe: the first real call is the probe.
   - `workspace.slug` / `workspace.title` — the authorized workspace;
   - `account.email` — who this MCP session is authenticated as;
   - `scopes[]` — repo→project bindings; match the current working directory
     against `scope` (longest matching prefix wins, since repos nest) to find
     this repo's `project_id`.
   - Self-hosted installs have no cloud account, so `workspace` and `account`
     may be absent. Omit the line entirely — never print `null` or a bare UUID.
2. Resolve the project **title** for that `project_id` via `daruma_project_list`
   (the `name` inside `scopes` is only the directory basename, not the project's
   title). Skip if the cwd matches no scope.
3. One scoped `daruma_list status=active` → count open tasks (do not enumerate
   the archive).
4. `mcpbox_runs_list` with `limit=5` (and `status=failed` if the user asked about
   failures) → recent pipeline runs.
5. Render, dropping any line whose value is unknown:

   ```
   ## mcpbox status
   workspace: <title> (<slug>)
   account:   <email>
   project:   <project title> — <repo path>
   open:      <N> tasks
   server:    ok (v<version>, sha <git_sha>) — only when `/mcpbox:doctor` ran
   runs:      <run_id> <status> · <run_id> <status> …
   ```

   Identity first: "which workspace am I in, as whom, on what project" is the
   question this command exists to answer; server health is the footnote.

6. Read-only.
