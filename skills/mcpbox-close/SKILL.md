---
name: mcpbox-close
description: Close an mcpbox task as done, with an optional completion note.
---

The user invoked `/mcpbox:close` (optionally with a task id or title in `$ARGUMENTS`).

## Steps

1. Identify the task:
   - If `$ARGUMENTS` has a task id, use it.
   - Else resolve the current in-progress task via `daruma_list status=in_progress`
     (if exactly one, use it; if several, list them and ask which).
2. `daruma_complete id=<id>` (preferred) — if the user gave a summary, pass it
   as `result_summary="<summary>"` (plus `reason` / `related_artifacts` when
   known); the completion note replaces a preliminary
   comment, so no separate `daruma_comment` call. Fallback:
   `daruma_set_status status=done comment={ body: "<summary>", kind: "outcome" }`
   (the comment lands atomically with the transition).
3. Confirm: `✓ closed <id> — <title>`. Do not touch other tasks.
