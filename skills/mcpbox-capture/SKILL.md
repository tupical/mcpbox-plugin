---
name: mcpbox-capture
description: Capture a durable, reusable lesson from this session into mcpbox.
---

The user invoked `/mcpbox:capture` (optionally with the lesson text in `$ARGUMENTS`).

## Steps

1. Distill ONE concrete reusable lesson from the session: a command, invariant, bug
   pattern, or file path — not a generic summary. If nothing durable, say so and stop.
2. Persist it with `mcpbox_knowledge_write` (kind `constraint`, `decision`,
   `project_context` or `research_note`; scope=project with the resolved `project_id`).
   If it only matters to one in-progress task, a `daruma_comment` on that task is enough.
3. Keep it to one or two sentences. Confirm what was recorded and where.
