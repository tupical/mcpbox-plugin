# @mcpbox/mcpbox-claude

MCPBox agent harness for **Claude Code**, **Codex**, **Cursor**, **Kimi Code**, and **OpenCode**.
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

Codex exposes the plugin's command workflows as skills. `codex-init` installs
the managed policy, MCP server, and routing skill; it does not write the unused
`~/.codex/prompts` surface. `codex-uninit` still removes legacy `mcpbox-*.md`
prompt files left by older installs.

Cursor and Kimi have no plugin manager; they are file installs, so re-run their
init to update:

```bash
npx -y @mcpbox/mcpbox-claude@latest cursor-init
npx -y @mcpbox/mcpbox-claude@latest kimi-init
npx -y @mcpbox/mcpbox-claude@latest opencode-init
```

On Claude and Codex a plugin update also reaches the policy you already
installed: at session start the hook rewrites every existing `mcpbox:policy`
block from the working directory up (`CLAUDE.md` on Claude, `AGENTS.md` plus
the `mcpbox` skill on Codex) to the running version, and says so in the
session context. It never adds a block and never touches text outside the
markers; `doctor --json` reports `policy_stale` until it has run. Set
`MCPBOX_NO_POLICY_SYNC=1` to keep installed blocks as they are.

### Project knowledge in every session

Agents answer repo questions right when they have the project's knowledge
(`mcpbox_knowledge_read`) in front of them, and rarely fetch it on their own.
Pair the machine once so the first prompt of every session carries it:

```bash
npx -y @mcpbox/mcpbox-claude login    # confirm the code in the browser
```

The workspace-bound token is kept in `~/.agents/mcpbox/credentials.json`
(mode 0600) and only ever sent over https; `logout` deletes the file, and
revoking the token itself happens in the workspace settings (Tokens). The
repo path of each new session goes to the server to find its project. Unpaired, rejected, or with the path
unbound in the paired workspace, the hook adds a ready `mcpbox_knowledge_read`
call instead of the text. Knowledge rows arrive
marked as workspace data, not instructions. Mode `off` disables both.

A stale version announces itself at session start on Claude, Codex, and Kimi.
The Cursor adapter installs no hooks (Cursor has them since 2026, unwired
here), so nothing announces anything there — check manually, or let
`cursor-init` in a routine update pass do it. Set
`MCPBOX_NO_UPDATE_CHECK=1` to disable the registry lookup entirely (air-gapped
installs, CI).

## What it manages

| Agent  | Policy surface                         | MCP server                          | Hooks |
|--------|----------------------------------------|-------------------------------------|-------|
| Claude | `CLAUDE.md` block + plugin (hooks, `/mcpbox:*`) | `claude mcp add` (`.mcp.json` / `~/.claude.json`) | plugin `hooks.json` |
| Codex  | `AGENTS.md` block + model-invoked plugin skills | `[mcp_servers.mcpbox]` in `~/.codex/config.toml` | — |
| Cursor | `.cursor/rules/mcpbox-policy.mdc` + `/mcpbox-mode` | `mcpbox` entry in `.cursor/mcp.json` | — |
| Kimi   | `AGENTS.md` block (`mcpbox:policy`)     | `mcpbox` entry in `~/.kimi-code/mcp.json` | `[[hooks]]` block in `~/.kimi-code/config.toml` |
| OpenCode | `AGENTS.md` block (`mcpbox:policy`)   | `mcpbox` remote entry under `mcp` in `~/.config/opencode/opencode.json` | — |

Codex skills are generated at package time from the same `commands/*.md` files
that provide Claude's `/mcpbox:*` commands. Codex selects these skills by their
descriptions; they are not user-entered slash commands.

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
mcpbox-claude codex-init [--dir DIR]    AGENTS.md policy + config.toml server + routing skill.
mcpbox-claude codex-uninit [--dir DIR]
mcpbox-claude cursor-init [--dir DIR]   .cursor/rules policy + .cursor/mcp.json server.
mcpbox-claude cursor-uninit [--dir DIR]
mcpbox-claude kimi-init [--dir DIR]     AGENTS.md policy + ~/.kimi-code/mcp.json server
                                        + ~/.kimi-code/config.toml [[hooks]].
mcpbox-claude kimi-uninit [--dir DIR]
mcpbox-claude opencode-init [--dir DIR] AGENTS.md policy + `mcpbox` entry under
                                        "mcp" in ~/.config/opencode/opencode.json.
mcpbox-claude opencode-uninit [--dir DIR]
mcpbox-claude doctor [--json]           Check the mcpbox MCP server + policy are wired.
mcpbox-claude mode [off|lite|full]       Show or set the shared pipeline mode.
```

All writes are idempotent and preserve surrounding hand-written content.
Set `MCPBOX_NO_UPDATE_CHECK=1` to disable hook update checks.

## License

UNLICENSED — MCPBox is a closed SaaS.

### Inherited Claude policy

`init --dir DIR` checks `CLAUDE.md` in DIR and its parent directories, matching
[Claude Code's cumulative directory hierarchy](https://code.claude.com/docs/en/memory#how-claude-md-files-load).
If a parent already has a managed MCPBox block, init inherits it and removes only
the requested directory's redundant managed block. Other local instructions and
parent files are preserved. A managed-only child file is removed. Re-running init
is idempotent; symlink/hardlink edits and malformed markers are refused.

`doctor --json` reports `policy_paths` and `policy_duplicate`; duplicate blocks
make readiness false. Parent blocks are not refreshed by a child install: run init
in the owning parent directory explicitly to update that policy. This check covers
the installer-owned `CLAUDE.md` hierarchy; it does not interpret imports,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, or exclusion settings.

Measured on 2026-09-11 for task `01a05e61-0067-7163-b74e-acacdd77cf5d`:
removing the redundant project block reduced the combined parent/project files
from 38,851 to 22,964 bytes. Two one-turn Haiku probes using the same command,
with tools disabled and no session persistence, both had zero cache reads.
`cache_creation_input_tokens` changed from 24,349 to 19,745 (−4,604; −18.9%);
uncached input stayed at 10 tokens. Reported costs were $0.049013 and $0.039800.
These are observed cold-start totals, not a controlled attribution of every token
or evidence about conversational-history cost. The AFTER probe was explicitly
approved by the owner with a $0.30 cap; no local instruction text is published.

The managed policy is a compact index (at most 100 lines) for all clients.
It retains tracker safety rules, mode handling and tool/skill entry points.
Routing and the execution-path verification rule before editing are supplied by
MCP `initialize.instructions` (`PLATFORM_INSTRUCTIONS` in
`crates/cloud-api/src/v1_gateway.rs`); clients without command skills use the plain tool
entry points. Reconnect the MCP server if its instructions are unavailable.
