---
description: Trace an mcpbox pipeline run — lineage chain, per-hop status, artifacts.
---

The user invoked `/mcpbox:trace` with a `run_id` in `$ARGUMENTS` (or asked about recent runs).

## Steps

1. If no `run_id`: `mcpbox_runs_list { limit:5 }` (add `status:"failed"` if the user asked
   about failures), list them, and ask which to trace (or trace the most recent).
2. `mcpbox_trace_get { run_id }`.
3. Render:

   ```
   ## run <run_id> — <status>
   <per-hop, in the order the trace returns them: layer, ok/failed, ms>
   handoff: <task_id or —>
   ```

4. If `status=failed`, surface the failing layer + reason and suggest retrying that
   hop with `mcpbox_pipeline_advance { run_id, layer }` once its input is fixed. Read-only.
