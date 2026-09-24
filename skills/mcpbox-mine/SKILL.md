---
name: mcpbox-mine
description: Show mcpbox tasks currently claimed / in progress for this session.
---

The user invoked `/mcpbox:mine`.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. `daruma_list` with `project_id = <resolved>`, `status = ["in_progress","in_review"]`, limit ~30.
3. Render the same compact table as `/mcpbox:tasks`, titled `## In progress — <N>`.
4. If empty: "nothing claimed — `/mcpbox:next` to claim the next ready task." Read-only.
