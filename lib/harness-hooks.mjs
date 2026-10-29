// Session-gate hooks for Codex and Cursor: the same hooks/*.mjs the Claude
// plugin runs, copied into a stable per-user dir (the npx cache that ran the
// installer is ephemeral) and registered in each CLI's own hooks.json.
//
//   ~/.agents/mcpbox/harness/{hooks,lib}/  the copied scripts
//   ~/.codex/hooks.json                    Claude-compatible events
//   ~/.cursor/hooks.json                   Cursor camelCase events, failClosed
//
// Our entries are recognised by the harness path in their command, so every
// foreign hook in those files is preserved and an install is idempotent.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_ASSETS = [
  ["hooks", "track-claims.mjs"],
  ["hooks", "stop.mjs"],
  ["hooks", "session-gate.mjs"],
  ["lib", "cloud-knowledge.mjs"],
  ["lib", "hook-input.mjs"],
  ["lib", "session-gate.mjs"],
];

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const harnessRoot = (homeDir) => join(resolve(homeDir ?? homedir()), ".agents", "mcpbox", "harness");
const isOurs = (root) => (h) => typeof h?.command === "string" && h.command.includes(root);

async function copyAssets(root) {
  let changed = false;
  for (const [subdir, file] of HARNESS_ASSETS) {
    const target = join(root, subdir, file);
    const content = await fs.readFile(join(packageRoot(), subdir, file));
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && existing.equals(content)) continue;
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    changed = true;
  }
  return changed;
}

async function readHooksFile(target) {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${target} is not a JSON object`);
  if (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) doc.hooks = {};
  return doc;
}

const command = (root, script, args) => `node "${join(root, "hooks", script)}"${args ? ` ${args}` : ""}`;

// Codex reads Claude-shaped groups: {matcher?, hooks: [{type, command, timeout}]}.
function codexEntries(root) {
  const group = (script, args, timeout, matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: command(root, script, args), timeout }],
  });
  return {
    SessionStart: group("session-gate.mjs", "start --surface=codex", 10),
    PostToolUse: group("track-claims.mjs", "--surface=codex", 5, "daruma_(plan_drain_next|ready_drain|claim|plan_materialize|set_status|comment)$"),
    Stop: group("stop.mjs", "--surface=codex", 10),
    SessionEnd: group("session-gate.mjs", "end --surface=codex", 10),
  };
}

// Cursor takes flat entries per camelCase event; failClosed so a hook that
// cannot run is not silently skipped (the scripts themselves exit 0 on any
// tracker failure, so this never blocks on the network).
function cursorEntries(root) {
  const entry = (script, args) => ({ command: command(root, script, args), failClosed: true });
  return {
    sessionStart: entry("session-gate.mjs", "start --surface=cursor"),
    afterMCPExecution: entry("track-claims.mjs", "--surface=cursor"),
    stop: entry("stop.mjs", "--surface=cursor"),
    sessionEnd: entry("session-gate.mjs", "end --surface=cursor"),
  };
}

const groupIsOurs = (root) => (g) => isOurs(root)(g) || (Array.isArray(g?.hooks) && g.hooks.some(isOurs(root)));

async function install(target, entries, root, base) {
  const assetsChanged = await copyAssets(root);
  const doc = (await readHooksFile(target)) ?? base();
  const before = JSON.stringify(doc);
  for (const [event, entry] of Object.entries(entries)) {
    const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    doc.hooks[event] = [...list.filter((g) => !groupIsOurs(root)(g)), entry];
  }
  const configChanged = JSON.stringify(doc) !== before;
  if (!assetsChanged && !configChanged) return { action: "unchanged", path: target };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  return { action: before === JSON.stringify(base()) ? "installed" : "updated", path: target };
}

async function remove(target, root) {
  const doc = await readHooksFile(target);
  let removed = false;
  if (doc) {
    for (const [event, list] of Object.entries(doc.hooks)) {
      if (!Array.isArray(list) || !list.some(groupIsOurs(root))) continue;
      const rest = list.filter((g) => !groupIsOurs(root)(g));
      if (rest.length) doc.hooks[event] = rest;
      else delete doc.hooks[event];
      removed = true;
    }
    if (removed) await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  }
  return { action: removed ? "removed-block" : "missing", path: target };
}

export const codexHooksPath = (homeDir) => join(resolve(homeDir ?? homedir()), ".codex", "hooks.json");
export const cursorHooksPath = (homeDir) => join(resolve(homeDir ?? homedir()), ".cursor", "hooks.json");

export function installCodexHooks({ homeDir } = {}) {
  const root = harnessRoot(homeDir);
  return install(codexHooksPath(homeDir), codexEntries(root), root, () => ({ hooks: {} }));
}

export function installCursorHooks({ homeDir } = {}) {
  const root = harnessRoot(homeDir);
  return install(cursorHooksPath(homeDir), cursorEntries(root), root, () => ({ version: 1, hooks: {} }));
}

export function removeCodexHooks({ homeDir } = {}) {
  return remove(codexHooksPath(homeDir), harnessRoot(homeDir));
}

export function removeCursorHooks({ homeDir } = {}) {
  return remove(cursorHooksPath(homeDir), harnessRoot(homeDir));
}
