---
description: Check the mcpbox harness is wired — MCP server, policy block, reachability.
---

The user invoked `/mcpbox:doctor`.

## Steps

1. MCP server: confirm the `mcpbox` server is connected (its `daruma_*` / `mcpbox_*`
   tools are available as `mcp__mcpbox__*`). If absent, tell the user to run
   `npx @mcpbox/mcpbox setup` and restart Claude Code.
2. Reachability: `daruma_healthz`. Report version + git_sha, or the failure verbatim.
3. Policy: confirm this project's `CLAUDE.md` contains the `mcpbox:policy` managed block.
   If missing, `npx -y @mcpbox/mcpbox-claude init` (or re-run setup).
4. Render a short checklist with ✓ / ✗ per item and a final READY / NOT READY line.
