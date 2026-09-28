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
description: mcpbox is the task tracker — plans and tasks go to mcpbox, not chat or files.
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

// User-level policy. Cursor reads no rule files from ~/.cursor/rules (User
// Rules live only in its settings UI), so a global install injects the policy
// through a sessionStart hook in ~/.cursor/hooks.json instead. The script is
// self-contained: the npx cache that ran us is ephemeral.
const SESSION_HOOK_NAME = "mcpbox-session-start.mjs";

function sessionHookPaths(homeDir) {
  const root = join(resolve(homeDir), ".cursor");
  return { script: join(root, "hooks", SESSION_HOOK_NAME), config: join(root, "hooks.json") };
}

function sessionHookScript() {
  return `// Managed by mcpbox-claude. Injects the MCPBox policy into Cursor sessions.
const BODY = ${JSON.stringify(BLOCK_BODY_PLAIN)};
process.stdout.write(JSON.stringify({ additional_context: BODY }) + "\\n");
`;
}

async function readHooks(target) {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${target} is not a JSON object`);
  }
  if (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) doc.hooks = {};
  return doc;
}

const isOurHook = (h) => typeof h?.command === "string" && h.command.includes(SESSION_HOOK_NAME);

export async function installCursorSessionHook({ homeDir } = {}) {
  const { script, config } = sessionHookPaths(homeDir);
  const content = sessionHookScript();
  let existingScript = null;
  try {
    existingScript = await fs.readFile(script, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const doc = (await readHooks(config)) ?? { version: 1, hooks: {} };
  if (doc.version === undefined) doc.version = 1;
  const entry = { command: `node "${script}"` };
  const before = Array.isArray(doc.hooks.sessionStart) ? doc.hooks.sessionStart : [];
  const ours = before.filter(isOurHook);
  const configSame = ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(entry);
  if (existingScript === content && configSame) return { action: "unchanged", path: config };

  await fs.mkdir(dirname(script), { recursive: true });
  await fs.writeFile(script, content);
  doc.hooks.sessionStart = [...before.filter((h) => !isOurHook(h)), entry];
  await fs.writeFile(config, JSON.stringify(doc, null, 2) + "\n");
  return { action: existingScript === null && ours.length === 0 ? "installed" : "updated", path: config };
}

export async function removeCursorSessionHook({ homeDir } = {}) {
  const { script, config } = sessionHookPaths(homeDir);
  let removed = false;
  const doc = await readHooks(config);
  if (doc && Array.isArray(doc.hooks.sessionStart) && doc.hooks.sessionStart.some(isOurHook)) {
    const rest = doc.hooks.sessionStart.filter((h) => !isOurHook(h));
    if (rest.length) doc.hooks.sessionStart = rest;
    else delete doc.hooks.sessionStart;
    await fs.writeFile(config, JSON.stringify(doc, null, 2) + "\n");
    removed = true;
  }
  try {
    await fs.unlink(script);
    removed = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return { action: removed ? "removed-block" : "missing", path: config };
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

export { rulePath, mcpPath, modeCommandPath, sessionHookPaths };
