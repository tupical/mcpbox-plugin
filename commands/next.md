---
description: Claim the next ready task from the active mcpbox plan and show its briefing.
---

The user invoked `/mcpbox:next`. This claims a task — afterward, control returns
to the user/agent to actually execute it.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. Active plan: `daruma_plan_list` filtered to `status = ["active","in_progress"]`, most recent.
   If none, stop with "no active plan — `daruma_plan_create` first".
3. `daruma_plan_next_task` with the plan id. The server atomically picks the next
   ready (unblocked) task and transitions `todo → in_progress`.
4. If "no ready task": print the server reason (e.g. "3 tasks blocked by X") and
   suggest `/mcpbox:plan` to inspect dependencies. Stop.
5. Otherwise render the briefing:

   ```
   ## Next task: <title>

   id:        <task_id>
   plan:      <plan_id>
   priority:  <pX>
   status:    🟢 in_progress
   ```

   Then `### Description` verbatim, and when non-empty `### Dependencies` and
   `### Related (links)`.
6. End with:

   ```
   → When done: daruma_complete task_id=<task_id> [comment="<summary>"]
   → On failure: daruma_comment + daruma_set_status status=todo
   ```

7. Briefing only — do not start executing the task in this command.
