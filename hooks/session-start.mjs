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
import { checkForUpdate, updateNotice } from "../lib/update-check.mjs";
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
      status: ["inbox", "todo", "in_progress", "in_review"],
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

export async function main() {
  const [data, update] = await Promise.all([
    fetchSummary().catch((err) => {
      if (process.env.MCPBOX_DEBUG) {
        process.stderr.write(`[mcpbox-claude/session-start] error: ${err?.message ?? err}\n`);
      }
      return null;
    }),
    checkForUpdate({ current: VERSION }),
  ]);
  const systemMessage = update?.outdated
    ? updateNotice(update.current, update.latest, isCodexSurface() ? "codex" : "claude")
    : undefined;

  if (!data) {
    writeHookOutput("SessionStart", "", { systemMessage });
    process.exit(0);
  }

  const { tasks, projectTitle } = data;

  if (!tasks || tasks.length === 0) {
    writeHookOutput(
      "SessionStart",
      "[mcpbox] No open tasks — run /mcpbox:tasks to verify, or /mcpbox:pipeline-run \"<idea>\" to open a maturity run.",
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
  lines.push("→ /mcpbox:next to claim the next task  |  /mcpbox:status for server + pipeline health");

  writeHookOutput("SessionStart", lines.join("\n"), { systemMessage });
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
