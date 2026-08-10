# @mcpbox/mcpbox-claude

MCPBox agent harness for **Claude Code**, **Codex**, **Cursor**, and **Kimi Code**.
Wires the single canonical MCP server (`https://mcpbox.ru/v1/mcp` — the daruma
tracker tools plus the platform pipeline `torii→satori→enma→yatagarasu→fujin→daruma`)
and drops a managed policy into each agent's native config file.

Normally installed for you by `npx @mcpbox/mcpbox setup` (or
`curl -fsSL https://mcpbox.ru/install.sh | sh`), which also registers the MCP
server and picks Repository, Repository (user scope), or Global. Use this CLI directly to manage
just the policy.

## Install and update

Claude Code and Codex install from the public git marketplace, which is the only
source either of them will auto-update from — Claude ignores `autoUpdate` on a
directory source, and Codex refuses outright (`marketplace … is not configured as
a Git marketplace`). Neither accepts an npm registry as a marketplace source, so
the repo below is generated from the published package on every release.

```bash
# Claude Code
claude plugin marketplace add https://github.com/tupical/mcpbox-plugin.git
claude plugin install mcpbox-claude@mcpbox
```

Then set `autoUpdate` on the marketplace in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "mcpbox": {
    "source": { "source": "git", "url": "https://github.com/tupical/mcpbox-plugin.git" },
    "autoUpdate": true
  }
}
```

Claude refreshes in the background 0–10 minutes after a session starts and the
new version is picked up by `/reload-plugins` or the next session — the running
one keeps what it loaded at startup.

```bash
# Codex
codex plugin marketplace add https://github.com/tupical/mcpbox-plugin.git
codex plugin add mcpbox --marketplace mcpbox
codex plugin marketplace upgrade mcpbox   # later, to update
```

Cursor and Kimi have no plugin manager; they are file installs, so re-run their
init to update:

```bash
npx -y @mcpbox/mcpbox-claude@latest cursor-init
npx -y @mcpbox/mcpbox-claude@latest kimi-init
```

A stale version announces itself at session start on Claude, Codex, and Kimi.
Cursor exposes no hooks at all, so nothing can announce anything there — check
manually, or let `cursor-init` in a routine update pass do it. Set
`MCPBOX_NO_UPDATE_CHECK=1` to disable the registry lookup entirely (air-gapped
installs, CI).

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
