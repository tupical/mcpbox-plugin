# @mcpbox/mcpbox-claude

MCPBox agent harness for **Claude Code**, **Codex**, **Cursor**, and **Kimi Code**.
Wires the single canonical MCP server (`https://mcpbox.ru/v1/mcp` — the daruma
tracker tools plus the platform pipeline `torii→satori→enma→yatagarasu→fujin→daruma`)
and drops a managed policy into each agent's native config file.

Normally installed for you by `npx @mcpbox/mcpbox setup` (or
`curl -fsSL https://mcpbox.ru/install.sh | sh`), which also registers the MCP
server and picks Repository, Repository (user scope), or Global. Use this CLI directly to manage
just the policy.

## What it manages

| Agent  | Policy surface                         | MCP server                          | Hooks |
|--------|----------------------------------------|-------------------------------------|-------|
| Claude | `CLAUDE.md` block + plugin (hooks, `/mcpbox:*`) | `claude mcp add` (`.mcp.json` / `~/.claude.json`) | plugin `hooks.json` |
| Codex  | `AGENTS.md` block (`mcpbox:policy`)     | `[mcp_servers.mcpbox]` in `~/.codex/config.toml` | — |
| Cursor | `.cursor/rules/mcpbox-policy.mdc` + `/mcpbox-mode` | `mcpbox` entry in `.cursor/mcp.json` | — |
| Kimi   | `AGENTS.md` block (`mcpbox:policy`)     | `mcpbox` entry in `~/.kimi-code/mcp.json` | `[[hooks]]` block in `~/.kimi-code/config.toml` |

All four agents accept `mcpbox mode [off|lite|full]` through the managed
policy. Claude also exposes `/mcpbox:mode`, Cursor exposes `/mcpbox-mode`, and
the shared value lives in `~/.agents/mcpbox/mode`.

Kimi specifics:

- MCP and hooks are **user-level** (Kimi reads hooks only from
  `~/.kimi-code/config.toml`; `$KIMI_CODE_HOME` is honored). One
  `/mcp-config login mcpbox` OAuth then covers every project.
- The hook scripts (`SessionStart` task summary, `UserPromptSubmit` routing
  hints, `Stop` auto-record nudge) are the same ones the Claude plugin ships;
  `kimi-init` copies them into `~/.kimi-code/mcpbox/` so the config never
  references an ephemeral npx cache path. `kimi-uninit` removes that directory.

## CLI

```
mcpbox-claude init [--dir DIR]          Managed CLAUDE.md policy block. Idempotent.
mcpbox-claude uninit [--dir DIR]        Remove the CLAUDE.md policy block.
mcpbox-claude codex-init [--dir DIR]    AGENTS.md policy + ~/.codex/config.toml server.
mcpbox-claude codex-uninit [--dir DIR]
mcpbox-claude cursor-init [--dir DIR]   .cursor/rules policy + .cursor/mcp.json server.
mcpbox-claude cursor-uninit [--dir DIR]
mcpbox-claude kimi-init [--dir DIR]     AGENTS.md policy + ~/.kimi-code/mcp.json server
                                        + ~/.kimi-code/config.toml [[hooks]].
mcpbox-claude kimi-uninit [--dir DIR]
mcpbox-claude doctor [--json]           Check the mcpbox MCP server + policy are wired.
mcpbox-claude mode [off|lite|full]       Show or set the shared pipeline mode.
```

All writes are idempotent and preserve surrounding hand-written content.
Set `MCPBOX_NO_UPDATE_CHECK=1` to disable hook update checks.

## License

UNLICENSED — MCPBox is a closed SaaS.
