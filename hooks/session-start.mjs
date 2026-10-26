#!/usr/bin/env node
// SessionStart hook: query the mcpbox tracker and print a compact summary of
// open tasks so Claude sees them at the top of every fresh session.
//
// Output goes to stdout — Claude Code injects it as a <system-reminder>.
// Exit 0 always so an mcpbox outage never blocks the session from opening.
//
// Fetch path: spawns the local `daruma` binary in stdio MCP mode (same tracker
// tools the mcpbox server exposes). Cloud-only setups without the local binary
// silently no-op (exit 0) — the /mcpbox:tasks command still works on demand.
// ponytail: stdio-only fetch; add an HTTP+token path for cloud-only if the
// silent no-op proves too quiet in practice.
//
// Environment variables:
//   MCPBOX_MCP_CMD   — command to start the stdio MCP server (default: "daruma")
//   MCPBOX_MCP_ARGS  — space-separated extra args (default: "mcp serve")
//   MCPBOX_SCOPE     — optional project_scope path filter

import { isCodexSurface, writeHookOutput } from "../lib/hook-output.mjs";
import { MCPClient } from "../lib/mcp-client.mjs";
import { syncPolicyBlocks } from "../lib/policy.mjs";
import { checkForUpdate, policyBlocks, updateNotice } from "../lib/update-check.mjs";
import { VERSION } from "../lib/version.mjs";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 12_000;
const MAX_TASKS = 15;

const STATUS_EMOJI = {
  inbox: "📥",
  todo: "⬜",
  in_progress: "🟢",
  in_review: "🔍",
  done: "✅",
  cancelled: "🚫",
};

function emoji(status) {
  return STATUS_EMOJI[status] ?? "❓";
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

function formatTask(t) {
  const e = emoji(t.status ?? "");
  const pri = t.priority ? `p${t.priority}` : "  ";
  const title = truncate(t.title ?? t.subject ?? "(no title)", 60);
  return `  ${e} [${pri}] ${title}`;
}

async function fetchSummary() {
  const cmd = process.env.MCPBOX_MCP_CMD ?? "daruma";
  const extraArgs = process.env.MCPBOX_MCP_ARGS ?? "mcp serve";
  const args = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : ["mcp", "serve"];
  const scope = process.env.MCPBOX_SCOPE;

  const client = new MCPClient();
  const timer = setTimeout(() => {
    client.stop().catch(() => {});
  }, TIMEOUT_MS);

  try {
    await client.start(cmd, args, { stderrLog: null });
    await client.initialize();

    let projectId = null;
    let projectTitle = null;
    try {
      const wsResult = await client.callTool("daruma_workspace_info", {});
      const ws = wsResult.parsed ?? {};
      projectId = ws.default_project ?? ws.defaultProject ?? null;
      projectTitle = ws.project_title ?? ws.title ?? null;
    } catch { /* no workspace info — continue without project filter */ }

    const listArgs = {
      status: "active",
      limit: MAX_TASKS + 1,
    };
    if (projectId) listArgs.project_id = projectId;
    if (!projectId && scope) listArgs.project_scope = scope;

    const listResult = await client.callTool("daruma_list", listArgs);
    const raw = listResult.parsed ?? listResult.text;
    const tasks = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.tasks)
        ? raw.tasks
        : Array.isArray(raw?.items)
          ? raw.items
          : [];

    await client.stop();
    clearTimeout(timer);
    return { tasks, projectTitle, projectId };
  } catch (err) {
    clearTimeout(timer);
    try { await client.stop(); } catch { /* ignore */ }
    throw err;
  }
}

// Block text to write: the server's copy, else the baked text (see policyBlocks).
export { policyBlocks };

// Bring the policy blocks already installed around cwd up to the server's
// text (see syncPolicyBlocks). Failures stay silent: a read-only tree must
// never block the session. MCPBOX_NO_POLICY_SYNC=1 opts out. Only the plugin
// surfaces sync: Kimi runs a copy frozen at kimi-init (no CLAUDE_PLUGIN_ROOT,
// no PLUGIN_DATA), whose policy would be stale by construction.
export async function syncPolicy(cwd = process.cwd(), env = process.env) {
  if (env.MCPBOX_NO_POLICY_SYNC) return { paths: [], origin: null };
  if (!env.CLAUDE_PLUGIN_ROOT && !isCodexSurface(env)) return { paths: [], origin: null };
  const blocks = await policyBlocks();
  const paths = [];
  // Codex has no hooks of its own (.codex-plugin declares none), so any plugin
  // surface refreshes the Codex carriers too: AGENTS.md up the tree, plus the
  // user-level SKILL.md — refreshed from Claude, retired from the Codex plugin.
  // Cursor rules up the tree likewise: Cursor runs no hook of this plugin.
  // Every plain carrier gets the same text as AGENTS.md.
  if (env.CLAUDE_PLUGIN_ROOT && !isCodexSurface(env)) {
    paths.push(...await syncPolicyBlocks({ cwd, block: blocks.claude }).catch(() => []));
  }
  if (isCodexSurface(env) || env.CLAUDE_PLUGIN_ROOT) {
    paths.push(...await syncPolicyBlocks({ cwd, file: "AGENTS.md", block: blocks.plain }).catch(() => []));
    try {
      const { retireCodexSkill, syncCodexSkill } = await import("../lib/codex.mjs");
      if (isCodexSurface(env)) {
        // Running as the Codex plugin, which ships the policy skill itself:
        // a user-level copy is now a duplicate (see retireCodexSkill).
        const { removed, backups } = await retireCodexSkill({ block: blocks.plain });
        paths.push(...removed.map((dir) => `${dir} (duplicate removed: the plugin ships this skill)`));
        paths.push(...backups.map((file) => `${file} (the differing copy, kept)`));
      } else {
        const skill = await syncCodexSkill({ block: blocks.plain });
        if (skill.action === "updated") paths.push(skill.path);
      }
    } catch { /* skill dir unwritable — AGENTS.md sync still counts */ }
    try {
      const { syncCursorRules } = await import("../lib/cursor.mjs");
      paths.push(...await syncCursorRules({ cwd, block: blocks.plain }));
    } catch { /* same: a rule we cannot write never blocks the session */ }
  }
  return { paths, origin: blocks.origin };
}

export async function main() {
  const [data, update, { paths: synced, origin }] = await Promise.all([
    fetchSummary().catch((err) => {
      if (process.env.MCPBOX_DEBUG) {
        process.stderr.write(`[mcpbox-claude/session-start] error: ${err?.message ?? err}\n`);
      }
      return null;
    }),
    checkForUpdate({ current: VERSION }),
    syncPolicy(),
  ]);
  const syncNote = synced.length
    ? `[mcpbox] Policy block refreshed to ${origin}: ${synced.join(", ")}\n`
    : "";
  // The user sees what we wrote into their files, not just the model.
  const notices = [
    update?.outdated
      ? updateNotice(update.current, update.latest, isCodexSurface() ? "codex" : "claude")
      : null,
    synced.length ? `mcpbox: policy block refreshed to ${origin} in ${synced.join(", ")}` : null,
  ].filter(Boolean);
  const systemMessage = notices.length ? notices.join("\n") : undefined;

  if (!data) {
    writeHookOutput("SessionStart", syncNote, { systemMessage });
    process.exit(0);
  }

  const { tasks, projectTitle } = data;

  if (!tasks || tasks.length === 0) {
    writeHookOutput(
      "SessionStart",
      syncNote + "[mcpbox] No open tasks — run /mcpbox:tasks to verify, or /mcpbox:pipeline-run \"<idea>\" to open a maturity run.",
      { systemMessage },
    );
    process.exit(0);
  }

  const shown = tasks.slice(0, MAX_TASKS);
  const extra = tasks.length > MAX_TASKS ? tasks.length - MAX_TASKS : 0;
  const count = tasks.length > MAX_TASKS ? MAX_TASKS + "+" : tasks.length;
  const plural = tasks.length !== 1 ? "s" : "";
  const header = projectTitle
    ? `[mcpbox] ${count} open task${plural} in "${projectTitle}":`
    : `[mcpbox] ${count} open task${plural}:`;

  const lines = [header, ...shown.map(formatTask)];
  if (extra > 0) lines.push(`  …and ${extra} more — /mcpbox:tasks for full list`);
  lines.push("→ /mcpbox:next to claim the next task  |  /mcpbox:status for server + pipeline health  |  raw idea: /mcpbox:pipeline-run");

  writeHookOutput("SessionStart", syncNote + lines.join("\n"), { systemMessage });
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
