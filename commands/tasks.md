---
description: Show open mcpbox tasks for the active project as a compact markdown table.
---

The user invoked `/mcpbox:tasks`.

Drive the mcpbox MCP server (do not invent IDs, do not write local plan files).

## Steps

1. Resolve project:
   - `daruma_workspace_info` → use `default_project` if set.
   - Else `daruma_project_list` → pick first. If none, say "no projects yet" and stop.

2. Fetch tasks server-side (don't filter locally):
   - `daruma_list project_id=<resolved> status=active limit=50`.
   - **Never** use `status=all` unless the user explicitly asked for the full archive; it is token-heavy.

3. Render exactly this format:

   ```
   ## <project title> — <N> open tasks

   | # | Status | Pri | Title | Plan |
   |---|--------|-----|-------|------|
   | 1 | 🟢 in_progress | p1 | <truncated title> | <plan_short> |
   ```

   - Status emoji: 📥 inbox, ⬜ todo, 🟢 in_progress, ✅ done.
   - Title truncated to 60 chars with `…`; `Plan` = last 8 chars of `plan_id` or `—`.

4. If >30 rows: show first 30, footer `…and <N> more — narrow with /mcpbox:mine`.
5. On `daruma_list` error: print it verbatim and stop.
6. Read-only — do not transition any task in this command.
