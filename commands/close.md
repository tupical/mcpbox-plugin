---
description: Close an mcpbox task as done, with an optional completion note.
---

The user invoked `/mcpbox:close` (optionally with a task id or title in `$ARGUMENTS`).

## Steps

1. Identify the task:
   - If `$ARGUMENTS` has a task id, use it.
   - Else resolve the current in-progress task via `daruma_list status=in_progress`
     (if exactly one, use it; if several, list them and ask which).
2. If the user gave a summary, first `daruma_comment task_id=<id> body="<summary>"`.
3. `daruma_complete task_id=<id>` (preferred) or `daruma_set_status status=done`.
4. Confirm: `✓ closed <id> — <title>`. Do not touch other tasks.
