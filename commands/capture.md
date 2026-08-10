---
description: Capture a durable, reusable lesson from this session into mcpbox.
---

The user invoked `/mcpbox:capture` (optionally with the lesson text in `$ARGUMENTS`).

## Steps

1. Distill ONE concrete reusable lesson from the session: a command, invariant, bug
   pattern, or file path — not a generic summary. If nothing durable, say so and stop.
2. Attach it where it belongs:
   - If a task is in progress, `daruma_comment task_id=<id> body="lesson: <lesson>"`.
   - Else, if the project uses docs, `daruma_doc_append` to the relevant doc.
3. Keep it to one or two sentences. Confirm what was recorded and where.
