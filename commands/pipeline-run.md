---
description: Open an mcpbox pipeline run from a raw idea; it ends as a daruma task via handoff.
---

The user invoked `/mcpbox:pipeline-run` with a raw idea/request in `$ARGUMENTS`.

The run turns the idea into a ready task; the task is created **only** via handoff,
never by materializing it directly.

## Steps

1. If `$ARGUMENTS` is empty, ask for the raw idea/request and stop.
2. Call `mcpbox_pipeline_run { source, kind:"text", body:"<idea>" }`. It returns
   `run_id` immediately while the run proceeds in the background. Poll
   `mcpbox_trace_get { run_id }` until the status is no longer `running`.
3. On failure, report the reason from `mcpbox_trace_get`; do not hand off an
   incomplete run.
4. Once the run is ready for handoff, call
   `mcpbox_pipeline_handoff { run_id, action_packet, policy_snapshot, project_slug? }`,
   taking `action_packet` from `artifacts.fujin.action_packet` and
   `policy_snapshot` from `artifacts.policy_snapshot` in the trace. This
   materializes the daruma task and returns `task_id`.
5. Verify with `mcpbox_trace_get { run_id }` (expect `status=handed_off`, a `task_id`) and
   report the run_id + task_id.
