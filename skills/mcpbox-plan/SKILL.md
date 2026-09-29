---
name: mcpbox-plan
description: Show the active mcpbox plan with a progress bar and dependency state.
---

The user invoked `/mcpbox:plan`.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. `daruma_plan_list status="draft,active"`, most recent first.
   If none, stop with "no active plan".
3. For the chosen plan, `daruma_plan_get` (single call — do not enumerate the archive).
4. Render:

   ```
   ## <plan title>
   goal: <goal>
   progress: [████░░░░] 4/9 done

   | # | Status | Pri | Task | Depends on |
   |---|--------|-----|------|-----------|
   ```

   - Progress bar from done/total; blocked tasks marked ⛔ with their blocker ids.
5. Do not call `daruma_plan_list status=completed` (token-heavy). Read-only.
