#!/usr/bin/env node
// Stop hook: auto-record nudge. Prints a <system-reminder>-style hint so Claude
// considers capturing a reusable lesson via daruma_comment at session end.
//
// Prints nothing when there is no active tracked task (MCPBOX_ACTIVE_TASK env
// absent), so it only fires when the agent was working on a tracked task.
//
// asyncRewake: true in hooks.json re-wakes Claude with the rewakeMessage only
// when this script exits 0 AND prints non-empty output.

import { pathToFileURL } from "node:url";

import { writeHookOutput } from "../lib/hook-output.mjs";

export function stopHookMessage(activeTask = "") {
  if (!activeTask) return "";
  return (
    `[mcpbox/auto-record] Active task: ${activeTask}\n` +
    `If this session produced a concrete reusable lesson (command, invariant, bug pattern, file path), ` +
    `capture it now via /mcpbox:capture or call daruma_comment directly:\n` +
    `  daruma_comment task_id="${activeTask}" body="lesson: <short durable lesson>"\n` +
    `Skip if there is nothing durable to record.\n`
  );
}

function main() {
  writeHookOutput("Stop", stopHookMessage(process.env.MCPBOX_ACTIVE_TASK ?? ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
