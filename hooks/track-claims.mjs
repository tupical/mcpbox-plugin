#!/usr/bin/env node
// PostToolUse: record successful claims, and the tasks this session wrote to
// (materialize / set_status / comment), never tasks merely mentioned or read.
// Same script on every surface; Cursor feeds it afterMCPExecution.
import { pathToFileURL } from "node:url";
import { readStdin } from "../lib/hook-input.mjs";
import { appendRecords, sessionIdOf, toolResultOf, trackedTasks } from "../lib/session-gate.mjs";

export { trackedTasks };

export function claimedTask(payload) {
  if (!/(?:^|__|[.:/])daruma_(?:plan_drain_next|ready_drain|claim)$/.test(payload?.tool_name ?? "")) return null;
  const result = toolResultOf(payload);
  if (!result) return null;
  const claim = result.claim ?? (result.data?.acquired === true ? result.data : null);
  if (!claim) return null;
  const task_id = result.task_id ?? claim.task_id;
  const record = { task_id, claim_id: claim.claim_id, agent_id: claim.agent_id };
  return Object.values(record).every((id) => typeof id === "string" && /^[\w-]+$/.test(id)) ? record : null;
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const id = claimedTask(payload);
  await appendRecords(sessionId, "claims", id ? [id] : []);
  await appendRecords(sessionId, "tracked", trackedTasks(payload));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {});
}
