// Kimi Code CLI surface for the mcpbox harness — parity with the Claude
// CLAUDE.md plugin and the Codex AGENTS.md surface. Three idempotent writes:
//   1. AGENTS.md policy block — same managed block as the Codex surface.
//      Kimi reads AGENTS.md from the WORKING DIRECTORY only: no walk up the
//      tree, no user-level instruction file. A global install therefore lands
//      it in ~/AGENTS.md, which no real project ever sees — hence the
//      UserPromptSubmit --policy injection below, which covers every cwd.
//   2. `$KIMI_CODE_HOME/mcp.json` (default `~/.kimi-code/mcp.json`) — upsert
//      the `mcpbox` HTTP server entry, preserving other servers. A bare `url`
//      entry means HTTP transport in Kimi. User-level on purpose: one server
//      entry (and one `/mcp-config login mcpbox` OAuth) covers every project.
//   3. `$KIMI_CODE_HOME/config.toml` — managed `[[hooks]]` block pointing at
//      the hook scripts copied into `$KIMI_CODE_HOME/mcpbox/`. Kimi reads
//      hooks only from the user-level config.toml (no project-level hooks),
//      so — like the Codex MCP entry — the block is fenced with comment
//      markers and replaced in place; surrounding hand-written TOML is
//      preserved.
//
// The policy body is BLOCK_BODY_PLAIN from lib/policy.mjs — one source of
// truth shared across CLAUDE.md / AGENTS.md / .cursor/rules, minus the
// Claude-only slash commands this surface cannot run.
//
// Hook semantics in Kimi (https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html):
// stdin carries the event JSON; exit 0 + stdout appends text to the context.
// Measured against Kimi 2026-08: UserPromptSubmit fires and its payload is
// {hook_event_name, session_id, cwd, prompt: [{type,text}]}; SessionStart is
// accepted in config.toml but never actually fires. The hook scripts are the
// same ones the Claude plugin ships (hooks/), copied into the Kimi home so
// the config never references an ephemeral npx cache path.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_BODY_PLAIN,
  MCP_URL,
  installManagedBlock,
  locateBlock,
  removeManagedBlock,
} from "./policy.mjs";

const BEGIN = "<!-- mcpbox:policy:begin -->";
const END = "<!-- mcpbox:policy:end -->";

const TOML_BEGIN = "# mcpbox:hooks:begin";
const TOML_END = "# mcpbox:hooks:end";

// Hook assets copied into the Kimi home: the three hook scripts and all their
// local imports. Tests import static dependencies and execute --policy for the
// dynamic policy.mjs import.
const HOOK_ASSETS = [
  ["hooks", "session-start.mjs"],
  ["hooks", "user-prompt-submit.mjs"],
  ["hooks", "stop.mjs"],
  ["lib", "mcp-client.mjs"],
  ["lib", "cloud-knowledge.mjs"],
  ["lib", "hook-output.mjs"],
  ["lib", "mode.mjs"],
  // user-prompt-submit.mjs --policy reads the policy body from here.
  ["lib", "policy.mjs"],
  ["lib", "update-check.mjs"],
  ["lib", "version.mjs"],
];

const MCP_ENTRY = { url: MCP_URL };

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Kimi data dir: explicit override (tests) > $KIMI_CODE_HOME > ~/.kimi-code.
export function kimiHomeDir(home) {
  if (home) return resolve(home);
  const env = process.env.KIMI_CODE_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".kimi-code");
}

// --- 1. AGENTS.md policy block in the project directory ---

export function installKimiPolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return installManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END, block: BLOCK_BODY_PLAIN });
}

export function removeKimiPolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return removeManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END });
}

// --- 2. `mcpbox` entry in the user-level mcp.json ---

async function readMcp(target) {
  try {
    const doc = JSON.parse(await fs.readFile(target, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`${target} is not a JSON object`);
    }
    if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
    return doc;
  } catch (err) {
    if (err.code === "ENOENT") return { mcpServers: {} };
    throw err;
  }
}

export async function installKimiMcp({ mcpPath, kimiHome } = {}) {
  const target = mcpPath ? resolve(mcpPath) : join(kimiHomeDir(kimiHome), "mcp.json");
  const doc = await readMcp(target);
  const before = doc.mcpServers.mcpbox;
  if (before && JSON.stringify(before) === JSON.stringify(MCP_ENTRY)) {
    return { action: "unchanged", path: target };
  }
  doc.mcpServers.mcpbox = MCP_ENTRY;
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  return { action: before ? "updated" : "installed", path: target };
}

export async function removeKimiMcp({ mcpPath, kimiHome } = {}) {
  const target = mcpPath ? resolve(mcpPath) : join(kimiHomeDir(kimiHome), "mcp.json");
  let doc;
  try {
    doc = await readMcp(target);
  } catch (err) {
    if (err.code === "ENOENT") return { action: "missing", path: target };
    throw err;
  }
  if (!doc.mcpServers.mcpbox) return { action: "missing", path: target };
  delete doc.mcpServers.mcpbox;
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  return { action: "removed-block", path: target };
}

// --- 3. Hooks: copied scripts + managed [[hooks]] block in config.toml ---

// TOML literal strings (single quotes) keep absolute paths with spaces or
// backslashes intact without escaping.
function hooksTomlBlock(assetsRoot) {
  const command = (file, args = "") =>
    `command = 'node "${join(assetsRoot, "hooks", file)}"${args}'`;
  return [
    "[[hooks]]",
    'event = "SessionStart"',
    command("session-start.mjs"),
    "timeout = 15",
    "",
    "[[hooks]]",
    'event = "UserPromptSubmit"',
    // --policy: Kimi reads AGENTS.md from the working directory only and
    // never fires SessionStart, so the managed policy rides in on the first
    // prompt of each session instead.
    command("user-prompt-submit.mjs", " --policy"),
    "",
    "[[hooks]]",
    'event = "Stop"',
    command("stop.mjs"),
    "",
  ].join("\n");
}

// Kimi re-serializes config.toml on its own saves and drops comments, so the
// managed-block markers vanish and every kimi-init appended another copy
// (measured 2026-09-27: 3× on a live install — each hook ran three times).
// Drop every [[hooks]] table outside the markers that runs one of our
// scripts, marked or not; trailing blank/comment lines stay with the file.
const OUR_HOOK = /mcpbox[\\/]+hooks[\\/]+(session-start|user-prompt-submit|stop)\.mjs/;

function stripOurHookTables(text) {
  const out = [];
  let table = null;
  const flush = () => {
    if (!table) return;
    const ours = table[0].trim() === "[[hooks]]" && table.some((l) => OUR_HOOK.test(l));
    if (ours) {
      let body = table.length;
      while (body > 1 && /^\s*(#.*)?$/.test(table[body - 1])) body--;
      out.push(...table.slice(body));
    } else {
      out.push(...table);
    }
    table = null;
  };
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      flush();
      table = [line];
    } else if (table) {
      table.push(line);
    } else {
      out.push(line);
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Rewrites `target` without unmarked copies of our hooks; the marked block
// (if its markers survived) is left for installManagedBlock to reconcile.
async function dropOrphanHooks(target) {
  let existing;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const found = locateBlock(existing, TOML_BEGIN, TOML_END);
  let next;
  if (found.kind === "block") {
    next =
      stripOurHookTables(existing.slice(0, found.start)) +
      existing.slice(found.start, found.end) +
      stripOurHookTables(existing.slice(found.end));
  } else {
    // No intact pair (Kimi dropped one or both markers): lone marker lines go
    // too, so the managed block is appended cleanly instead of refused.
    const lone = new RegExp(`^(${TOML_BEGIN}|${TOML_END})[ \\t]*\\r?\\n?`, "gm");
    next = stripOurHookTables(existing.replace(lone, ""));
  }
  if (next !== existing) await fs.writeFile(target, next);
}

async function copyHookAssets(assetsRoot) {
  for (const [subdir, file] of HOOK_ASSETS) {
    const target = join(assetsRoot, subdir, file);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.copyFile(join(packageRoot(), subdir, file), target);
  }
}

export async function installKimiHooks({ configPath, kimiHome } = {}) {
  const home = kimiHomeDir(kimiHome);
  const assetsRoot = join(home, "mcpbox");
  await copyHookAssets(assetsRoot);
  const target = configPath ? resolve(configPath) : join(home, "config.toml");
  await dropOrphanHooks(target);
  return installManagedBlock({
    target,
    begin: TOML_BEGIN,
    end: TOML_END,
    block: hooksTomlBlock(assetsRoot),
  });
}

export async function removeKimiHooks({ configPath, kimiHome } = {}) {
  const home = kimiHomeDir(kimiHome);
  const target = configPath ? resolve(configPath) : join(home, "config.toml");
  await dropOrphanHooks(target);
  const block = await removeManagedBlock({ target, begin: TOML_BEGIN, end: TOML_END });
  // The assets dir is ours (namespaced `mcpbox` under the Kimi home) — drop it.
  const assetsRoot = join(home, "mcpbox");
  await fs.rm(assetsRoot, { recursive: true, force: true });
  return block;
}

// --- All three surfaces at once (what `mcpbox-claude kimi-init` calls) ---

export async function installKimi({ projectDir, kimiHome } = {}) {
  const policy = await installKimiPolicy({ projectDir });
  const mcp = await installKimiMcp({ kimiHome });
  const hooks = await installKimiHooks({ kimiHome });
  return { policy, mcp, hooks };
}

export async function removeKimi({ projectDir, kimiHome } = {}) {
  const policy = await removeKimiPolicy({ projectDir });
  const mcp = await removeKimiMcp({ kimiHome });
  const hooks = await removeKimiHooks({ kimiHome });
  return { policy, mcp, hooks };
}

export { BEGIN, END, TOML_BEGIN, TOML_END };
