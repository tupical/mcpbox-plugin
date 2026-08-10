// Cursor surface for the mcpbox harness — parity with the Claude CLAUDE.md
// plugin. Two idempotent writes:
//   1. `.cursor/rules/mcpbox-policy.mdc` — an always-applied rule. We own the
//      whole file, so it's written wholesale (no in-file markers needed).
//   2. `.cursor/mcp.json` — upsert the `mcpbox` HTTP server entry, leaving any
//      other servers the user configured untouched.
//
// Rule body is BLOCK_BODY_PLAIN from lib/policy.mjs — the shared source of
// truth, minus the Claude-only slash commands this surface cannot run.

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_BODY_PLAIN, MCP_URL } from "./policy.mjs";

const RULE_FRONTMATTER = `---
description: Workspace policy — mcpbox is the default tracker AND maturity pipeline (torii→…→fujin→daruma). Triggered by mentions of "трекер", "tracker", "task tracker", "backlog", "pipeline", "план", "задача". Overrides ad-hoc trackers and OMC plan files.
globs: ["**/*"]
alwaysApply: true
---

`;

function ruleContent() {
  return RULE_FRONTMATTER + BLOCK_BODY_PLAIN;
}

function rulePath(projectDir) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return join(dir, ".cursor", "rules", "mcpbox-policy.mdc");
}

function mcpPath(projectDir) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return join(dir, ".cursor", "mcp.json");
}

const MCP_ENTRY = { type: "http", url: MCP_URL };
const MODE_COMMAND_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "commands", "mode.md");

function modeCommandPath(projectDir) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return join(dir, ".cursor", "commands", "mcpbox-mode.md");
}

export async function installCursorModeCommand({ projectDir } = {}) {
  const target = modeCommandPath(projectDir);
  const content = await fs.readFile(MODE_COMMAND_SOURCE, "utf8");
  await fs.mkdir(dirname(target), { recursive: true });
  let existing = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing === content) return { action: "unchanged", path: target };
  await fs.writeFile(target, content);
  return { action: existing === null ? "installed" : "updated", path: target };
}

export async function removeCursorModeCommand({ projectDir } = {}) {
  const target = modeCommandPath(projectDir);
  try {
    await fs.unlink(target);
    return { action: "removed-file", path: target };
  } catch (err) {
    if (err.code === "ENOENT") return { action: "missing", path: target };
    throw err;
  }
}

// `.cursor/rules/mcpbox-policy.mdc` — whole-file managed rule.
export async function installCursorRule({ projectDir } = {}) {
  const target = rulePath(projectDir);
  const content = ruleContent();
  await fs.mkdir(dirname(target), { recursive: true });
  let existing = null;
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing === content) return { action: "unchanged", path: target };
  await fs.writeFile(target, content);
  return { action: existing === null ? "installed" : "updated", path: target };
}

export async function removeCursorRule({ projectDir } = {}) {
  const target = rulePath(projectDir);
  try {
    await fs.unlink(target);
    return { action: "removed-file", path: target };
  } catch (err) {
    if (err.code === "ENOENT") return { action: "missing", path: target };
    throw err;
  }
}

// `.cursor/mcp.json` — upsert only the `mcpbox` entry, preserve the rest.
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

export async function installCursorMcp({ projectDir } = {}) {
  const target = mcpPath(projectDir);
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

export async function removeCursorMcp({ projectDir } = {}) {
  const target = mcpPath(projectDir);
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

// Both surfaces at once (what `mcpbox-claude cursor-init` calls).
export async function installCursor({ projectDir } = {}) {
  const rule = await installCursorRule({ projectDir });
  const mcp = await installCursorMcp({ projectDir });
  const mode = await installCursorModeCommand({ projectDir });
  return { rule, mcp, mode };
}

export async function removeCursor({ projectDir } = {}) {
  const rule = await removeCursorRule({ projectDir });
  const mcp = await removeCursorMcp({ projectDir });
  const mode = await removeCursorModeCommand({ projectDir });
  return { rule, mcp, mode };
}

export { rulePath, mcpPath, modeCommandPath };
