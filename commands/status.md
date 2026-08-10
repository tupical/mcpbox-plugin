---
description: Show mcpbox server + pipeline health — daruma_healthz, open count, recent runs.
---

The user invoked `/mcpbox:status`.

## Steps

1. `daruma_healthz` — if it fails, report "mcpbox unreachable" and how to start the
   server; stop (do not fall back to `.omc/plans/` or markdown).
2. Resolve project (`daruma_workspace_info` → `default_project`).
3. One scoped `daruma_list status=active` → count open tasks (do not enumerate the archive).
4. `mcpbox_runs_list` with `limit=5` (and `status=failed` if the user asked about failures)
   → recent pipeline runs.
5. Render:

   ```
   ## mcpbox status
   server:   ok (v<version>, sha <git_sha>)
   project:  <title>
   open:     <N> tasks
   runs:     <run_id> <status> · <run_id> <status> …
   ```

6. Read-only.
