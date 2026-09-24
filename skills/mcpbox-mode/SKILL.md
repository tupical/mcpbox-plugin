---
name: mcpbox-mode
description: Set how strictly raw ideas route through the mcpbox maturity pipeline (off | lite | full).
---

The user invoked `/mcpbox:mode` with `$ARGUMENTS` = `off` | `lite` | `full` (empty → show current).

## What each level does

- **off** — no pipeline nudging; don't raise the pipeline on your own. Raw material still
  isn't materialized straight into daruma — ask the user instead.
- **lite** (default) — nudge toward the pipeline only when the input explicitly mentions it
  (pipeline / maturity / handoff / конвейер …).
- **full** — assess every substantive request for **rawness**. A raw idea, hypothesis, or
  undecided direction matures through the pipeline (`mcpbox_pipeline_run` → …fujin → handoff)
  before it becomes a task.

The mode only tunes how actively you *offer* the pipeline. It does not change where work
lands — that is the one routing rule in the MCP server's `initialize` instructions (tool descriptions
point to it): decided-and-bounded work and
follow-ups extending a run that already handed off go straight to daruma; raw material — and
anything belonging to a run still in flight — goes through the pipeline.

The level persists across sessions (stored in `~/.agents/mcpbox/mode`) and is read by the
UserPromptSubmit hook, which injects the matching reminder on each prompt.

## Steps

1. Run:
   - Claude plugin: `node "${CLAUDE_PLUGIN_ROOT}/bin/mcpbox-claude.mjs" mode $ARGUMENTS`
   - Other agents: `npx -y @mcpbox/mcpbox-claude@latest mode $ARGUMENTS`
   - empty `$ARGUMENTS` → prints the current mode.
   - invalid value → the CLI errors with the allowed set (`off | lite | full`); relay it verbatim.
2. Report the resulting mode in one line.
