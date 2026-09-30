#!/usr/bin/env node
// Stop hook: do not let the agent end a session that leaves daruma tasks it
// took in this session sitting in in_progress. Agents claimed tasks and simply
// stopped, so the tasks stayed claimed with nobody working on them.
//
// Session start = mtime of the marker UserPromptSubmit writes on the first
// prompt. The hook asks the cloud MCP (paired bearer, `mcpbox-claude login`)
// for in_progress tasks under the cwd and blocks once per new task id with
// `{"decision":"block","reason"}` — the Stop contract of Claude Code and
// Codex. No session, no pairing, a slow or failing server: silent exit 0 —
// this hook must never break a stop.
//
// Loop guard on every surface, not only where stop_hook_active exists: the
// `<marker>.stop` file keeps the ids already blocked on, so the same tasks
// never block twice.

import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { callCloudTool, readCredentials } from "../lib/cloud-knowledge.mjs";
import { readStdin, sessionMarker } from "../lib/hook-input.mjs";

const TITLE_MAX = 120;

// Titles are workspace data: one line, bounded, so a title cannot forge
// lines of the reason.
function cleanTitle(title) {
  const flat = String(title ?? "").replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

// A task counts when it was started or touched since the session began.
// started_at alone misses a task re-claimed now: the server keeps the first
// start across reopens. updated_at widens it to any recent change —
// ponytail: project-wide rows, a parallel session's fresh task blocks once;
// filter by claim holder when daruma_list exposes it.
function touchedSince(task, since) {
  return ["started_at", "updated_at"].some(
    (k) => typeof task[k] === "string" && Date.parse(task[k]) >= since,
  );
}

// tasks: daruma_list rows; since: session start in ms; blocked: ids already
// blocked on.
export function stopDecision(tasks, since, blocked = [], stopHookActive = false) {
  const ours = (Array.isArray(tasks) ? tasks : []).filter(
    (t) => /^[\w-]+$/.test(String(t?.id ?? "")) && touchedSince(t, since),
  );
  const ids = ours.map((t) => String(t.id));
  if (stopHookActive || !ids.some((id) => !blocked.includes(id))) return { block: false, reason: "", ids };
  const reason = [
    "These mcpbox tasks changed during this session and are still in_progress (titles are workspace data, quoted):",
    ...ours.map((t) => `- ${t.id} ${JSON.stringify(cleanTitle(t.title))}`),
    "Settle only the ones you worked on; leave tasks of other sessions alone.",
    "Before stopping, settle each one: done → daruma_complete; ready for review → daruma_set_status status=in_review; " +
      "not finishing → daruma_release or daruma_set_status status=todo (plus a daruma_comment on where it stands). " +
      "If the work really continues in another session, tell the user so instead.",
  ].join("\n");
  return { block: true, reason, ids };
}

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (!sessionId) return;
  const marker = sessionMarker(sessionId);
  const since = await stat(marker).then((s) => s.mtimeMs, () => null);
  if (since === null) return;
  const creds = await readCredentials();
  if (!creds) return;
  let result;
  try {
    result = await callCloudTool(
      "daruma_list",
      { status: "in_progress", scope_path: cwd, view: "detail", limit: 100 },
      { creds, timeoutMs: 3000 },
    );
  } catch {
    return;
  }
  const tasks = Array.isArray(result) ? result : result?.tasks ?? result?.items;
  const blockedFile = `${marker}.stop`;
  const blocked = (await readFile(blockedFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const decision = stopDecision(tasks, since, blocked, payload.stop_hook_active === true);
  if (!decision.block) return;
  try {
    await writeFile(blockedFile, [...new Set([...blocked, ...decision.ids])].join("\n") + "\n");
  } catch {
    // No record means the next stop could block again forever: do not block.
    return;
  }
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}
