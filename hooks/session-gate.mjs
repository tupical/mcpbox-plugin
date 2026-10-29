#!/usr/bin/env node
// Session lifecycle half of the gate, one script for every CLI surface:
//   session-gate.mjs start [--surface=…]  SessionStart (also after compaction):
//                                         print this agent's open tasks.
//   session-gate.mjs end   [--surface=…]  SessionEnd: release the claims this
//                                         session still holds.
// Failures stay silent: the tracker being away never blocks a session.

import { pathToFileURL } from "node:url";

import { callCloudTool, readCredentials } from "../lib/cloud-knowledge.mjs";
import { readStdin } from "../lib/hook-input.mjs";
import {
  localClaimAgents, openTasksNote, readRecords, sessionIdOf, sessionStartOutput, surfaceOf, validClaims,
} from "../lib/session-gate.mjs";

const TIMEOUT_MS = 2500;
const DETAIL_MAX = 10;

export async function openTasks(cwd, { creds, call = callCloudTool } = {}) {
  const opts = { creds, timeoutMs: TIMEOUT_MS };
  const [info, local, list] = await Promise.all([
    call("daruma_workspace_info", {}, opts).catch(() => null),
    localClaimAgents(),
    call("daruma_list", { status: "in_progress,in_review", scope_path: cwd, limit: 50 }, opts),
  ]);
  const items = Array.isArray(list?.items) ? list.items : [];
  // Summary rows carry no claim: read the in_progress ones back to keep only ours.
  const detailed = await Promise.all(items.map((t, i) => (
    t.status === "in_progress" && i < DETAIL_MAX
      ? call("daruma_get", { id: t.id }, opts).then((full) => ({ ...t, current_claim: full?.current_claim }), () => t)
      : t
  )));
  // This agent: the pairing token's (workspace_info) and the MCP connections
  // that claimed on this machine (local session records).
  const agents = [info?.mcp_agent_id, ...local].filter(Boolean);
  return openTasksNote(detailed.filter((t) => t.status === "in_review" || t.current_claim), agents);
}

// Claims recorded in this session that the server still shows as ours.
export function releasable(tasks, claimed) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => t?.status === "in_progress" && claimed.some(
    (c) => c.task_id === String(t.id) && c.claim_id === t.current_claim?.claim_id && c.agent_id === t.current_claim?.agent_id,
  )).map((t) => String(t.id));
}

async function start(payload, surface) {
  const creds = await readCredentials();
  if (!creds) return;
  const note = await openTasks(payload?.cwd ?? payload?.workspace_roots?.[0] ?? process.cwd(), { creds });
  const out = sessionStartOutput(surface, note);
  if (out) process.stdout.write(typeof out === "string" ? `${out}\n` : `${JSON.stringify(out)}\n`);
}

async function end(payload) {
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const claimed = validClaims(await readRecords(sessionId, "claims"));
  if (!claimed.length) return;
  const creds = await readCredentials();
  if (!creds) return;
  const opts = { creds, timeoutMs: TIMEOUT_MS };
  const ids = [...new Set(claimed.map((c) => c.task_id))];
  const tasks = await Promise.all(ids.map((id) => callCloudTool("daruma_get", { id }, opts).catch(() => null)));
  // The claim's own agent: the hook's pairing token is a different agent than
  // the MCP connection that claimed, and release defaults to the token's.
  await Promise.all(releasable(tasks, claimed).map((task_id) => (
    callCloudTool("daruma_release", { task_id, agent_id: claimed.find((c) => c.task_id === task_id).agent_id }, opts).catch(() => null)
  )));
}

async function main() {
  const event = process.argv[2];
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || "{}"); } catch { /* no payload */ }
  if (event === "start") await start(payload, surfaceOf());
  else if (event === "end") await end(payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => {
    process.stdout.write("", () => process.exit(0));
  });
}
