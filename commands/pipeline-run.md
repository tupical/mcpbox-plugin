---
description: Open an mcpbox pipeline run from a raw idea; it ends as a daruma task via handoff.
---

The user invoked `/mcpbox:pipeline-run` with a raw idea/request in `$ARGUMENTS`.

The run turns the idea into a ready task; the task is created **only** via handoff,
never by materializing it directly.

## Steps

1. If `$ARGUMENTS` is empty, ask for the raw idea/request and stop.
2. Call `mcpbox_pipeline_run { source, kind:"text", body:"<idea>", project_id }`.
   `source` is a URI or short label of where the idea came from (as `plan.source`;
   never an invented link); `project_id` comes from `daruma_workspace_info` for this
   repo (omit it only if unbound). Any `kind` outside text/document/reference/binary/event
   is a 422. It returns
   `run_id` immediately while the run proceeds in the background. Poll
   `mcpbox_trace_get { run_id }` until the status is no longer `running`.
3. On failure, report the reason from `mcpbox_trace_get`; do not hand off an
   incomplete run. Recovery: a run `failed` at layer L → retry with
   `mcpbox_pipeline_advance { run_id, layer: L }` after fixing the input; fujin
   `not_ready` → advance from `yatagarasu`; or ask the owner. Never
   `daruma_plan_materialize` the idea directly to get around a failed run.
   A 409 with `existing_run_id` means the same intake is already a run: follow that
   run instead of opening another. If `mcpbox_runs_list` shows a *running* run of the
   same idea you are restating, pass `relation:{supersedes:<run_id>}` to replace it.
4. Once the run is ready for handoff, call
   `mcpbox_pipeline_handoff { run_id, project_slug? }`: the packet and policy
   come from the run (an `action_packet` with another id is a 422). Without
   `run_id`, pass `action_packet` and `policy_snapshot` from the trace. This
   materializes the daruma task, returns `task_id` and any `warnings`
   (`plan_source_*`, `source_upstream_kept`) — fix the source or ask.
5. Verify with `mcpbox_trace_get { run_id }` (expect `status=handed_off`, a `task_id`) and
   report the run_id + task_id.
