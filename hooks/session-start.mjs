#!/usr/bin/env node
// SessionStart refreshes policy and update notices; task selection is explicit.

import { isCodexSurface, writeHookOutput } from "../lib/hook-output.mjs";
import { syncPolicyBlocks } from "../lib/policy.mjs";
import { checkForUpdate, policyBlocks, updateNotice } from "../lib/update-check.mjs";
import { VERSION } from "../lib/version.mjs";
import { pathToFileURL } from "node:url";

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
  const [update, { paths: synced, origin }] = await Promise.all([
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

  writeHookOutput("SessionStart", syncNote, { systemMessage });
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
