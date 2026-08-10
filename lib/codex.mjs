// Codex surface for the mcpbox harness — parity with the Claude CLAUDE.md
// plugin. Four idempotent writes:
//   1. AGENTS.md policy block. Measured against Codex 0.146: AGENTS.md is
//      read from the working directory, NOT from a parent — a global install
//      lands it in ~/AGENTS.md where no project sees it, hence (3) and (4).
//   2. `~/.codex/config.toml` [mcp_servers.mcpbox] pointing at the single
//      canonical HTTP endpoint. Codex's config is global-only, so the entry
//      is fenced with comment markers and replaced in place — surrounding
//      hand-written TOML is preserved.
//   3. `$CODEX_HOME/skills/mcpbox/SKILL.md` — the same policy, reachable from
//      every working directory instead of just the install one.
//   4. `$CODEX_HOME/prompts/mcpbox-*.md` — Codex's slash commands. Generated
//      from the plugin's commands/, which already use exactly this shape
//      (frontmatter `description` + "the user invoked" body).
//
// The policy body is BLOCK_BODY_PLAIN from lib/policy.mjs — one source of
// truth shared across CLAUDE.md / AGENTS.md / .cursor/rules, minus the
// Claude-only slash commands this surface cannot run.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_BODY_PLAIN,
  MCP_URL,
  installManagedBlock,
  removeManagedBlock,
} from "./policy.mjs";

const BEGIN = "<!-- mcpbox:policy:begin -->";
const END = "<!-- mcpbox:policy:end -->";

const TOML_BEGIN = "# mcpbox:mcp:begin";
const TOML_END = "# mcpbox:mcp:end";
const TOML_BLOCK = `[mcp_servers.mcpbox]
url = "${MCP_URL}"
`;

// Codex data dir: explicit override (tests) > $CODEX_HOME > ~/.codex.
export function codexHomeDir(home) {
  if (home) return resolve(home);
  const env = process.env.CODEX_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".codex");
}

function codexConfigPath(configPath) {
  return configPath ? resolve(configPath) : join(codexHomeDir(), "config.toml");
}

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// AGENTS.md policy block in the project directory.
export function installCodexPolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return installManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END, block: BLOCK_BODY_PLAIN });
}

export function removeCodexPolicy({ projectDir } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return removeManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END });
}

// [mcp_servers.mcpbox] entry in the global ~/.codex/config.toml.
// `configPath` overrides the target (used by tests).
export async function installCodexMcp({ configPath } = {}) {
  const target = codexConfigPath(configPath);
  // Someone else may already declare the server — oh-my-claudecode keeps its own
  // "OMC MANAGED MCP REGISTRY" block, for one. Appending ours next to it makes
  // `[mcp_servers.mcpbox]` a duplicate key, which is a TOML parse error: codex
  // then fails to read its whole config. An entry that already points at us is
  // the entry we wanted, so leave it alone.
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch { /* absent → install */ }
  const outsideOurBlock = existing.replace(
    new RegExp(`${TOML_BEGIN}[\\s\\S]*?${TOML_END}\\n?`, "g"),
    "",
  );
  if (/^\s*\[mcp_servers\.mcpbox\]/m.test(outsideOurBlock)) {
    return { action: "unchanged", path: target, reason: "already declared outside the managed block" };
  }
  return installManagedBlock({ target, begin: TOML_BEGIN, end: TOML_END, block: TOML_BLOCK });
}

export function removeCodexMcp({ configPath } = {}) {
  return removeManagedBlock({ target: codexConfigPath(configPath), begin: TOML_BEGIN, end: TOML_END });
}

// The policy as a user-level Codex skill, so it is reachable from any working
// directory — AGENTS.md alone only covers the one the installer ran in.
export async function installCodexSkill({ codexHome } = {}) {
  const target = join(codexHomeDir(codexHome), "skills", "mcpbox", "SKILL.md");
  const body = `---
name: mcpbox
description: MCPBox/daruma routing policy — read before creating tasks or plans, choosing between the daruma tracker and the maturity pipeline, or when the user mentions the tracker, backlog, plan, decomposition, or \`mcpbox mode\`.
---

${BLOCK_BODY_PLAIN}`;
  let before = null;
  try {
    before = await fs.readFile(target, "utf8");
  } catch { /* absent → install */ }
  if (before === body) return { action: "unchanged", path: target };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { action: before === null ? "installed" : "updated", path: target };
}

export async function removeCodexSkill({ codexHome } = {}) {
  const dir = join(codexHomeDir(codexHome), "skills", "mcpbox");
  try {
    await fs.access(dir);
  } catch {
    return { action: "missing", path: join(dir, "SKILL.md") };
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { action: "removed-block", path: join(dir, "SKILL.md") };
}

// Codex slash commands live in `$CODEX_HOME/prompts/<name>.md` and are invoked
// as `/<name>`; the plugin's `commands/tasks.md` becomes `/mcpbox-tasks`.
// There is no `:` namespace here, so the body's `/mcpbox:tasks` is rewritten
// to the name the user can actually type.
export function codexPromptName(commandFile) {
  return `mcpbox-${commandFile.replace(/\.md$/, "")}`;
}

export async function installCodexPrompts({ codexHome } = {}) {
  const source = join(packageRoot(), "commands");
  const targetDir = join(codexHomeDir(codexHome), "prompts");
  const files = (await fs.readdir(source)).filter((f) => f.endsWith(".md")).sort();
  await fs.mkdir(targetDir, { recursive: true });
  let written = 0;
  for (const file of files) {
    const name = codexPromptName(file);
    const body = (await fs.readFile(join(source, file), "utf8"))
      .replace(/\/mcpbox:([a-z-]+)/g, "/mcpbox-$1");
    const target = join(targetDir, `${name}.md`);
    let before = null;
    try {
      before = await fs.readFile(target, "utf8");
    } catch { /* absent */ }
    if (before === body) continue;
    await fs.writeFile(target, body);
    written += 1;
  }
  return { action: written ? "installed" : "unchanged", path: targetDir, count: files.length };
}

export async function removeCodexPrompts({ codexHome } = {}) {
  const targetDir = join(codexHomeDir(codexHome), "prompts");
  let files = [];
  try {
    files = await fs.readdir(targetDir);
  } catch {
    return { action: "missing", path: targetDir };
  }
  // Only our own `mcpbox-*.md` — a hand-written prompt next to them survives.
  const ours = files.filter((f) => f.startsWith("mcpbox-") && f.endsWith(".md"));
  await Promise.all(ours.map((f) => fs.rm(join(targetDir, f), { force: true })));
  return { action: ours.length ? "removed-block" : "missing", path: targetDir };
}

// Every surface at once (what `mcpbox-claude codex-init` calls).
export async function installCodex({ projectDir, codexHome } = {}) {
  const policy = await installCodexPolicy({ projectDir });
  const mcp = await installCodexMcp();
  const skill = await installCodexSkill({ codexHome });
  const prompts = await installCodexPrompts({ codexHome });
  return { policy, mcp, skill, prompts };
}

export async function removeCodex({ projectDir, codexHome } = {}) {
  const policy = await removeCodexPolicy({ projectDir });
  const mcp = await removeCodexMcp();
  const skill = await removeCodexSkill({ codexHome });
  const prompts = await removeCodexPrompts({ codexHome });
  return { policy, mcp, skill, prompts };
}

export { BEGIN, END, TOML_BEGIN, TOML_END, codexConfigPath };
