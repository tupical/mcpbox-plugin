---
name: mcpbox-sync
description: Refresh the mcpbox task/plan view for the active project from the server.
---

The user invoked `/mcpbox:sync`.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. Re-fetch server-side: one scoped `daruma_list status=active`, and if a plan is active,
   one `daruma_plan_get`.
3. Summarize what changed since the session's last view (new / closed / newly blocked),
   in ≤5 lines. Read-only — this only refreshes context, it does not transition tasks.
