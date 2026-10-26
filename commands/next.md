---
description: Claim the next ready task from the active mcpbox plan and show its briefing.
---

The user invoked `/mcpbox:next`. This claims a task — afterward, control returns
to the user/agent to actually execute it.

## Steps

1. Resolve project (`daruma_workspace_info` → `default_project`).
2. Active plan: `daruma_plan_list` with `status = "active"`, `sort = "updated"`,
   `limit = 1` — the most recently updated plan (the default order is by creation).
   If none, stop with "no active plan — decided work: `daruma_plan_materialize`; raw idea: `/mcpbox:pipeline-run`".
3. `daruma_plan_drain_next` with the plan id. The server atomically picks the next
   ready (unblocked) task and claims it for this session; it returns null when no
   unclaimed ready task remains. Keep the returned `run_id`: the server opened that
   run for this claim. A null drain already aborted its own run — nothing to close.
4. If "no ready task": print the server reason (e.g. "3 tasks blocked by X") and
   suggest `/mcpbox:plan` to inspect dependencies. Stop.
5. Otherwise render the briefing:

   ```
   ## Next task: <title>

   id:        <task_id>
   plan:      <plan_id>
   run:       <run_id>
   priority:  <pX>
   status:    🟢 in_progress
   ```

   Then `### Description` verbatim, and when non-empty `### Dependencies` and
   `### Related (links)`.
6. End with:

   ```
   → When done: daruma_complete id=<task_id> [result_summary="<summary>"]
     then daruma_run_complete run_id=<run_id>
   → On failure: daruma_set_status status=todo comment={ body, kind: "blocker" }
     then daruma_run_abort run_id=<run_id> reason=<reason>
   ```

   An open run keeps the plan from auto-closing after its last task; the
   `plan_close_blocked_by_run` warning names it in `details.run_id`.

7. Briefing only — do not start executing the task in this command.
