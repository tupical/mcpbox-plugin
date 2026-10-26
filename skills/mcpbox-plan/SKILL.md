---
name: mcpbox-plan
description: Show the active mcpbox plan with a progress bar and dependency state.
---

The user invoked `/mcpbox:plan`.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. `daruma_plan_list status="draft,active" sort="updated" limit=1` — the most recently
   updated plan (the default order is by creation, and its first page can miss it).
   If none, stop with "no active plan — decided work: `daruma_plan_materialize`; raw idea: `/mcpbox:pipeline-run`".
3. For the chosen plan, `daruma_plan_get view="tasks"` (single call — do not enumerate the archive).
   It lists every plan task (done included) with `status`, `priority`, `depends_on` and
   `blocked_by`; the default `progress` view caps each group at five open tasks.
4. Render:

   ```
   ## <plan title>
   progress: [████░░░░] 4/9 done

   | # | Status | Pri | Task | Depends on |
   |---|--------|-----|------|-----------|
   ```

   - Progress bar from `progress.tasks_done`/`progress.tasks_total`; one row per task in plan order.
   - Tasks with a non-empty `blocked_by` marked ⛔ with those blocker ids.
5. Do not call `daruma_plan_list status=completed` (token-heavy). Read-only.
