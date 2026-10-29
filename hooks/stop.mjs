#!/usr/bin/env node
// Stop hook: do not let the agent end a session that leaves daruma tasks it
// took or wrote to in this session open (todo / in_progress) without an
// outcome comment. Agents claimed tasks and simply stopped, so the tasks stayed
// claimed with nobody working on them and nobody knowing where they stood.
//
// Only what PostToolUse recorded for this session (successful claims and
// writes) establishes ownership; unknown sessions stay silent. The .stop file
// caps the gate at MAX_STOP_CYCLES reminders per pending set (see stopDecision).

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { callCloudTool, readCredentials } from "../lib/cloud-knowledge.mjs";
import { readStdin, sessionMarker } from "../lib/hook-input.mjs";
import { readRecords, sessionIdOf, stopDecision, stopOutput, surfaceOf, validClaims } from "../lib/session-gate.mjs";

export { stopDecision };

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const claimed = validClaims(await readRecords(sessionId, "claims"));
  const tracked = await readRecords(sessionId, "tracked");
  if (!claimed.length && !tracked.length) return;
  const creds = await readCredentials();
  if (!creds) return;
  const ids = [...new Set([...claimed, ...tracked].map((r) => r.task_id))];
  const tasks = await Promise.all(ids.map((id) => callCloudTool(
    "daruma_get", { id }, { creds, timeoutMs: 3000 },
  ).catch(() => null)));
  const stateFile = `${sessionMarker(sessionId)}.stop`;
  const cycles = await readFile(stateFile, "utf8").then(JSON.parse).catch(() => ({ count: 0, ids: [] }));
  // Claude/Codex/Kimi say stop_hook_active; Cursor counts loop_count instead.
  const continuing = payload.stop_hook_active === true || Number(payload.loop_count) > 0;
  const decision = stopDecision(tasks, { claimed, tracked }, cycles, continuing);
  if (decision.block) {
    try {
      await writeFile(stateFile, `${JSON.stringify(decision.state)}\n`, { mode: 0o600 });
    } catch {
      // No record means the next stop could block again forever: do not block.
      return;
    }
  }
  const out = stopOutput(surfaceOf(), decision);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {}).finally(() => {
    // Aborted fetch connections can outlive main; flush the decision before exiting.
    process.stdout.write("", () => process.exit(0));
  });
}
