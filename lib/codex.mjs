// Codex surface for the mcpbox harness — parity with the Claude CLAUDE.md
// plugin. Three idempotent writes:
//   1. AGENTS.md policy block. Codex reads AGENTS.md from the git root down
//      to cwd (measured 0.156.1, 2026-09-27; 0.146 read cwd only). Outside a
//      repo, or above it, a global install in ~/AGENTS.md is still unseen,
//      hence (3).
//   2. `~/.codex/config.toml` [mcp_servers.mcpbox] pointing at the single
//      canonical HTTP endpoint. Codex's config is global-only, so the entry
//      is fenced with comment markers and replaced in place — surrounding
//      hand-written TOML is preserved.
//   3. `$CODEX_HOME/skills/mcpbox/SKILL.md` — the same policy, reachable from
//      every working directory instead of just the install one. Only for
//      Codex without the plugin: the plugin package ships this very skill
//      (scripts/generate-codex-skills.mjs), and a plugin session retires the
//      global copy (retireCodexSkill) so the policy is not loaded twice.
//
// The policy body is the plain surface's text — the server's copy when this
// machine holds one (policyBlocks in lib/update-check.mjs), else
// BLOCK_BODY_PLAIN from lib/policy.mjs: one text shared across AGENTS.md /
// SKILL.md / .cursor/rules, minus the Claude-only slash commands this surface
// cannot run. `block` defaults to the baked text.

import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BLOCK_BODY_PLAIN,
  blockNeedsSync,
  mcpUrl,
  installManagedBlock,
  removeManagedBlock,
} from "./policy.mjs";

const BEGIN = "<!-- mcpbox:policy:begin -->";
const END = "<!-- mcpbox:policy:end -->";

const TOML_BEGIN = "# mcpbox:mcp:begin";
const TOML_END = "# mcpbox:mcp:end";
const tomlBlock = () => `[mcp_servers.mcpbox]
url = "${mcpUrl()}"
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

// AGENTS.md policy block in the project directory.
export function installCodexPolicy({ projectDir, block = BLOCK_BODY_PLAIN } = {}) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  return installManagedBlock({ target: join(dir, "AGENTS.md"), begin: BEGIN, end: END, block });
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
  return installManagedBlock({ target, begin: TOML_BEGIN, end: TOML_END, block: tomlBlock() });
}

export function removeCodexMcp({ configPath } = {}) {
  return removeManagedBlock({ target: codexConfigPath(configPath), begin: TOML_BEGIN, end: TOML_END });
}

// The policy as a Codex skill, so it is reachable from any working directory —
// AGENTS.md alone only covers the one the installer ran in. The plugin package
// carries it as skills/mcpbox/SKILL.md; codex-init writes the same text to the
// user skill dir for Codex without the plugin, in the text AGENTS.md carries.
export function skillText(block = BLOCK_BODY_PLAIN) {
  return `---
name: mcpbox
description: MCPBox/daruma routing policy — read before creating tasks or plans, choosing between the daruma tracker and the maturity pipeline, or when the user mentions the tracker, backlog, plan, decomposition, or \`mcpbox mode\`.
---

${block}`;
}

export async function installCodexSkill({ codexHome, block } = {}) {
  const target = join(codexHomeDir(codexHome), "skills", "mcpbox", "SKILL.md");
  const body = skillText(block);
  let before = null;
  try {
    before = await fs.readFile(target, "utf8");
  } catch { /* absent → install */ }
  if (before === body) return { action: "unchanged", path: target };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { action: before === null ? "installed" : "updated", path: target };
}

// SessionStart counterpart of installCodexSkill: refresh an installed skill
// to `block` (the text AGENTS.md gets) under the same rules as
// syncPolicyBlocks (never create, never through a link, never roll a newer
// one back).
export async function syncCodexSkill({ codexHome, dryRun = false, block } = {}) {
  const target = join(codexHomeDir(codexHome), "skills", "mcpbox", "SKILL.md");
  let before;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.nlink > 1) return { action: "unchanged", path: target };
    before = await fs.readFile(target, "utf8");
  } catch {
    return { action: "missing", path: target };
  }
  if (!blockNeedsSync(before, skillText(block))) return { action: "unchanged", path: target };
  // dryRun (doctor): report the staleness without writing.
  if (dryRun) return { action: "stale", path: target };
  return installCodexSkill({ codexHome, block });
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

// A copy this harness wrote: our frontmatter name followed by the policy
// version marker that every generated skill carries right after it.
const MANAGED_SKILL_RE = /^---\nname: mcpbox\n[\s\S]*?\n---\n\n<!-- mcpbox-claude:policy-version \S+ -->\n/;

// Match setup's cleanup boundary: no Git-owned paths or linked ancestors.
async function safeRetirementRoot(root) {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    try {
      if (!(await fs.lstat(dir)).isDirectory()) return false;
    } catch { return false; }
    if (dir === dirname(dir)) break;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root, encoding: "utf8", env: { ...env, LC_ALL: "C" }, timeout: 5000,
  });
  return !git.error && git.status !== 0 && /not a git repository/.test(git.stderr ?? "");
}

// The plugin ships the policy skill, so a user-level copy beside it is a
// duplicate. Retire it from both places a copy can live — $CODEX_HOME/skills
// (codex-init) and ~/.agents/skills (where `mcpbox setup` moves user skills,
// leaving a link behind) — but only a copy recognized as ours: a lone,
// unlinked SKILL.md with our header and a version not newer than this plugin.
// A copy that differs from the current text (an older release or a hand edit)
// is moved to `$CODEX_HOME/mcpbox-skill-backup-*` first, never just deleted.
// Anything else (extra files, a foreign or newer skill) stays and is reported.
// A copy in the server's text (`block`, what SessionStart wrote) is current too.
export async function retireCodexSkill({ codexHome, home = homedir(), dryRun = false, block } = {}) {
  const codexDir = codexHomeDir(codexHome);
  const roots = [join(codexDir, "skills", "mcpbox"), join(home, ".agents", "skills", "mcpbox")];
  const result = { removed: [], backups: [], kept: [] };
  const links = [];
  const retired = new Set();
  for (const dir of roots) {
    let info;
    try {
      info = await fs.lstat(dir);
    } catch { continue; }
    if (!await safeRetirementRoot(info.isSymbolicLink() ? dirname(dir) : dir)) {
      result.kept.push(dir);
      continue;
    }
    if (info.isSymbolicLink()) {
      links.push(dir);
      continue;
    }
    const file = join(dir, "SKILL.md");
    let text = null;
    try {
      const entries = await fs.readdir(dir);
      const stat = await fs.lstat(file);
      if (entries.length === 1 && stat.isFile() && stat.nlink === 1) text = await fs.readFile(file, "utf8");
    } catch { /* not a directory, or no SKILL.md */ }
    const lf = text?.replace(/\r\n/g, "\n") ?? "";
    // blockNeedsSync is false for the current text and for a newer release;
    // only the former is ours to drop.
    const current = [skillText(), skillText(block)].some((text) => normalizeSkill(lf) === normalizeSkill(text));
    if (!MANAGED_SKILL_RE.test(lf) || (!current && !blockNeedsSync(lf, skillText(block)))) {
      result.kept.push(dir);
      continue;
    }
    if (!current && !await safeRetirementRoot(codexDir)) {
      result.kept.push(dir);
      continue;
    }
    if (dryRun) {
      result.removed.push(dir);
      continue;
    }
    if (!current) {
      const backup = await fs.mkdtemp(join(codexDir, "mcpbox-skill-backup-"));
      await fs.copyFile(file, join(backup, "SKILL.md"));
      result.backups.push(join(backup, "SKILL.md"));
    }
    await fs.rm(file);
    await fs.rmdir(dir);
    result.removed.push(dir);
    retired.add(resolve(dir));
  }
  // A link is removed only when it pointed at a copy retired just now.
  for (const link of links) {
    let target;
    try {
      target = resolve(dirname(link), await fs.readlink(link));
    } catch { continue; }
    if (retired.has(target) || (dryRun && result.removed.includes(target))) {
      if (!dryRun) await fs.unlink(link);
      result.removed.push(link);
    } else result.kept.push(link);
  }
  return result;
}

function normalizeSkill(text) {
  return text.replace(/^(---\n[\s\S]*?\n---\n\n)<!-- mcpbox-claude:policy-version \S+ -->\n/, "$1");
}

// Legacy cleanup only: Codex 0.147 does not load `$CODEX_HOME/prompts`, so
// codex-init no longer writes these files, but codex-uninit removes old ones.
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
export async function installCodex({ projectDir, codexHome, block } = {}) {
  const policy = await installCodexPolicy({ projectDir, block });
  const mcp = await installCodexMcp();
  const skill = await installCodexSkill({ codexHome, block });
  return { policy, mcp, skill };
}

export async function removeCodex({ projectDir, codexHome } = {}) {
  const policy = await removeCodexPolicy({ projectDir });
  const mcp = await removeCodexMcp();
  const skill = await removeCodexSkill({ codexHome });
  const prompts = await removeCodexPrompts({ codexHome });
  return { policy, mcp, skill, prompts };
}

export { BEGIN, END, TOML_BEGIN, TOML_END, codexConfigPath };
