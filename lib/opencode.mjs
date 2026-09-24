// OpenCode surface for the mcpbox harness — parity with the Codex/Kimi
// surfaces. Two idempotent writes:
//   1. AGENTS.md policy block in the project directory. OpenCode discovers
//      AGENTS.md from the working directory up the tree (same convention as
//      Codex), so a project install covers that project without extra wiring.
//   2. `$OPENCODE_CONFIG_DIR/opencode.json` (default follows XDG:
//      `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode/opencode.json`)
//      — upsert the `mcpbox` entry under the top-level `mcp` key, preserving
//      every other config key and server. A remote entry (`type: "remote"` +
//      `url`) is OpenCode's HTTP transport.
//
// The policy body is BLOCK_BODY_PLAIN from lib/policy.mjs — one source of
// truth shared across CLAUDE.md / AGENTS.md / .cursor/rules, minus the
// Claude-only slash commands this surface cannot run.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BLOCK_BODY_PLAIN,
  MCP_URL,
  installManagedBlock,
  removeManagedBlock,
} from "./policy.mjs";

const BEGIN = "<!-- mcpbox:policy:begin -->";
const END = "<!-- mcpbox:policy:end -->";

const MCP_ENTRY = { type: "remote", url: MCP_URL, enabled: true };

// OpenCode config dir: explicit override (tests) > $OPENCODE_CONFIG_DIR >
// XDG ($XDG_CONFIG_HOME/opencode, else ~/.config/opencode).
export function opencodeHomeDir(home) {
  if (home) return resolve(home);
  const env = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (env) return env;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "opencode");
}

function opencodeConfigPath(configPath, home) {
  return configPath ? resolve(configPath) : join(opencodeHomeDir(home), "opencode.json");
}

// --- 1. AGENTS.md policy block in the project directory ---

export function installOpencodePolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return installManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END, block: BLOCK_BODY_PLAIN });
}

export function removeOpencodePolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return removeManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END });
}

// --- 2. `mcpbox` entry under `mcp` in opencode.json ---

async function readConfig(target) {
  try {
    const doc = JSON.parse(await fs.readFile(target, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`${target} is not a JSON object`);
    }
    if (!doc.mcp || typeof doc.mcp !== "object") doc.mcp = {};
    return doc;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function installOpencodeMcp({ configPath, home } = {}) {
  const target = opencodeConfigPath(configPath, home);
  const doc = await readConfig(target);
  const before = doc.mcp?.mcpbox;
  if (before && JSON.stringify(before) === JSON.stringify(MCP_ENTRY)) {
    return { action: "unchanged", path: target };
  }
  doc.mcp = { ...doc.mcp, mcpbox: MCP_ENTRY };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  return { action: before ? "updated" : "installed", path: target };
}

export async function removeOpencodeMcp({ configPath, home } = {}) {
  const target = opencodeConfigPath(configPath, home);
  let doc;
  try {
    doc = await readConfig(target);
  } catch (err) {
    if (err.code === "ENOENT") return { action: "missing", path: target };
    throw err;
  }
  if (!doc.mcp?.mcpbox) return { action: "missing", path: target };
  delete doc.mcp.mcpbox;
  await fs.writeFile(target, JSON.stringify(doc, null, 2) + "\n");
  return { action: "removed-block", path: target };
}

// --- Both surfaces at once (what `mcpbox-claude opencode-init` calls) ---

export async function installOpencode({ projectDir, home } = {}) {
  const policy = await installOpencodePolicy({ projectDir });
  const mcp = await installOpencodeMcp({ home });
  return { policy, mcp };
}

export async function removeOpencode({ projectDir, home } = {}) {
  const policy = await removeOpencodePolicy({ projectDir });
  const mcp = await removeOpencodeMcp({ home });
  return { policy, mcp };
}

export { BEGIN, END };
