#!/usr/bin/env node
// `mcpbox-claude` — project-scoped harness entry point.
//
// Subcommands:
//   mcpbox-claude init [--dir DIR]      Write the managed CLAUDE.md policy block
//                                       (daruma tracker + full pipeline). Idempotent.
//   mcpbox-claude uninit [--dir DIR]    Remove the managed policy block.
//   mcpbox-claude doctor [--json]       Check the mcpbox MCP server + policy are wired.
//   mcpbox-claude mode [off|lite|full]  Get/set pipeline strictness (raw-idea routing).
//   mcpbox-claude --version | --help
//
// ponytail: no orchestrator (start/team-from-plan) or self-update here — the
// mcpbox server already exposes the pipeline tools; add an omc-team driver only
// if a CLI-driven execution loop is actually requested.

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { installPolicy, removePolicy, policyHierarchy, stalePolicyPaths, competingPolicyPaths, versionedBlock, BLOCK_BODY, BLOCK_BODY_PLAIN } from "../lib/policy.mjs";
import { policyBlocks, readPolicyCache } from "../lib/update-check.mjs";
import { VERSION } from "../lib/version.mjs";
import { credentialsPath, login, logout, readCredentials } from "../lib/cloud-knowledge.mjs";
import {
  installCodex,
  removeCodex,
  installCodexPolicy,
  installCodexSkill,
  retireCodexSkill,
  syncCodexSkill,
} from "../lib/codex.mjs";
import {
  installCursor,
  removeCursor,
  installCursorRule,
  removeCursorRule,
  installCursorMcp,
  removeCursorMcp,
  installCursorModeCommand,
  removeCursorModeCommand,
  installCursorSessionHook,
  removeCursorSessionHook,
  syncCursorRules,
} from "../lib/cursor.mjs";
import { installKimi, removeKimi } from "../lib/kimi.mjs";
import { installCodexHooks, installCursorHooks, removeCodexHooks, removeCursorHooks } from "../lib/harness-hooks.mjs";
import { installOpencode, removeOpencode } from "../lib/opencode.mjs";
import { readMode, writeMode, MODES } from "../lib/mode.mjs";
import { installGitHook, prepareCommitMsg, removeGitHook } from "../lib/git-trailer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const HELP = `mcpbox-claude v${pkg.version} — MCPBox agent harness (Claude / Codex / Cursor / Kimi / OpenCode)

Usage:
  mcpbox-claude init [--dir DIR]        Write the managed CLAUDE.md policy block
                                        (daruma tracker + full pipeline). Idempotent.
  mcpbox-claude uninit [--dir DIR]      Remove the managed CLAUDE.md policy block.
  mcpbox-claude codex-init [--dir DIR]  Write AGENTS.md policy, ~/.codex/config.toml
                                        [mcp_servers.mcpbox], the mcpbox skill
                                        (for Codex without the plugin, which ships
                                        that skill itself) and the session-gate
                                        hooks in ~/.codex/hooks.json. Idempotent.
  mcpbox-claude codex-uninit [--dir DIR]
  mcpbox-claude cursor-init [--dir DIR] Write .cursor/rules/mcpbox-policy.mdc +
                                        .cursor/mcp.json mcpbox entry, plus the
                                        session-gate hooks in ~/.cursor/hooks.json.
                                        Idempotent.
                                        In $HOME the policy goes to a sessionStart
                                        hook in ~/.cursor/hooks.json instead.
  mcpbox-claude cursor-uninit [--dir DIR]
  mcpbox-claude kimi-init [--dir DIR]   Write AGENTS.md policy + ~/.kimi-code/mcp.json
                                        mcpbox entry + [[hooks]] in ~/.kimi-code/config.toml.
                                        Idempotent.
  mcpbox-claude kimi-uninit [--dir DIR]
  mcpbox-claude opencode-init [--dir DIR] Write AGENTS.md policy + mcpbox entry
                                          under "mcp" in ~/.config/opencode/
                                          opencode.json. Idempotent.
  mcpbox-claude opencode-uninit [--dir DIR]
  mcpbox-claude doctor [--json]         Check the mcpbox MCP server + policy are wired.
  mcpbox-claude login                   Pair this machine so hooks load project knowledge.
  mcpbox-claude logout                  Forget the pairing token.
  mcpbox-claude mode [off|lite|full]    Get/set pipeline strictness (how raw ideas route).
  mcpbox-claude git-hook [install|uninstall] [--dir DIR]
                                        Manage the git prepare-commit-msg hook that adds
                                        "Daruma-Task: <id>" trailers (work/<id> branch or
                                        tasks claimed in this session). Never overwrites a
                                        foreign hook.
  mcpbox-claude export-marketplace [--dir DIR]
                                        Mirror this package to a stable directory usable as
                                        a Claude Code marketplace; prints the path.
                                        Default: ~/.agents/mcpbox/marketplace
  mcpbox-claude --version | -v
  mcpbox-claude --help    | -h
`;

function parseDirFlag(rest) {
  let projectDir;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dir") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) throw new Error("--dir requires a directory");
      projectDir = v;
    } else {
      throw new Error(`Unknown flag: ${rest[i]}`);
    }
  }
  return { projectDir };
}

const VERB = {
  installed: "Created",
  inherited: "Using ancestor policy:",
  updated: "Refreshed mcpbox block in",
  appended: "Appended mcpbox block to",
  unchanged: "Already current:",
  "removed-block": "Removed mcpbox block from",
  "removed-file": "Removed",
  missing: "No mcpbox block found at",
  malformed: "Left alone (broken or repeated mcpbox markers — fix by hand):",
};

async function cmdInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const r = await installPolicy({ projectDir, block: (await installBlocks()).claude });
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
  process.stdout.write("Open Claude Code in this directory to pick it up.\n");
}

async function cmdUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const r = await removePolicy({ projectDir });
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
}

// What an install writes: the server's text this machine last fetched, else
// the baked one — the text the next session start would sync to anyway.
const installBlocks = () => policyBlocks({ fetch: false });

function report(r) {
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
}

async function cmdCodexInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, skill } = await installCodex({ projectDir, block: (await installBlocks()).plain });
  report(policy);
  report(mcp);
  report(skill);
  report(await installCodexHooks());
}

async function cmdCodexUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, skill, prompts } = await removeCodex({ projectDir });
  report(policy);
  report(mcp);
  report(skill);
  report(prompts);
  report(await removeCodexHooks());
}

// Cursor ignores ~/.cursor/rules: in the home dir the policy goes through the
// user-level sessionStart hook, and a rule left by older installs is dropped.
function isHomeDir(projectDir) {
  return resolve(projectDir ?? process.cwd()) === resolve(homedir());
}

async function installCursorHome(homeDir) {
  report(await installCursorSessionHook({ homeDir }));
  const stale = await removeCursorRule({ projectDir: homeDir });
  if (stale.action !== "missing") report(stale);
  report(await installCursorModeCommand({ projectDir: homeDir }));
}

async function cmdCursorInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  if (isHomeDir(projectDir)) {
    await installCursorHome(homedir());
    report(await installCursorMcp({ projectDir: homedir() }));
    report(await installCursorHooks());
    return;
  }
  const { rule, mcp, mode } = await installCursor({ projectDir, block: (await installBlocks()).plain });
  report(rule);
  report(mcp);
  report(mode);
  // The session gate is user-level: Cursor runs ~/.cursor/hooks.json in every project.
  report(await installCursorHooks());
}

async function cmdCursorUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  if (isHomeDir(projectDir)) {
    report(await removeCursorSessionHook({ homeDir: homedir() }));
    report(await removeCursorRule({ projectDir: homedir() }));
    report(await removeCursorMcp({ projectDir: homedir() }));
    report(await removeCursorModeCommand({ projectDir: homedir() }));
    report(await removeCursorHooks());
    return;
  }
  const { rule, mcp, mode } = await removeCursor({ projectDir });
  report(rule);
  report(mcp);
  report(mode);
}

async function cmdKimiInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, hooks } = await installKimi({ projectDir });
  report(policy);
  report(mcp);
  report(hooks);
}

async function cmdKimiUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, hooks } = await removeKimi({ projectDir });
  report(policy);
  report(mcp);
  report(hooks);
}

async function cmdOpencodeInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp } = await installOpencode({ projectDir });
  report(policy);
  report(mcp);
}

async function cmdOpencodeUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp } = await removeOpencode({ projectDir });
  report(policy);
  report(mcp);
}

// Policy-only variants — for callers (mcpbox-cli setup) that already own the
// MCP-server wiring and just need the managed policy file dropped.
async function cmdCodexPolicy(rest) {
  const { projectDir } = parseDirFlag(rest);
  report(await installCodexPolicy({ projectDir, block: (await installBlocks()).plain }));
}

// The user-level policy skill alone: `codex-skill` for Codex without the
// plugin, `codex-skill-retire` once the plugin (which ships it) is installed.
async function cmdCodexSkill() {
  report(await installCodexSkill({ block: (await installBlocks()).plain }));
}

async function cmdCodexSkillRetire() {
  const { removed, backups, kept } = await retireCodexSkill({ block: (await installBlocks()).plain });
  for (const path of removed) process.stdout.write(`✓ Removed duplicate ${path}\n`);
  for (const path of backups) process.stdout.write(`✓ Saved the differing copy to ${path}\n`);
  for (const path of kept) process.stdout.write(`! Left alone (not a copy mcpbox wrote) ${path}\n`);
  if (!removed.length && !kept.length) process.stdout.write("✓ No user-level mcpbox skill to retire\n");
}

async function cmdCursorPolicy(rest) {
  const { projectDir } = parseDirFlag(rest);
  if (isHomeDir(projectDir)) return installCursorHome(homedir());
  report(await installCursorRule({ projectDir, block: (await installBlocks()).plain }));
  report(await installCursorModeCommand({ projectDir }));
}


function mcpServerPresent() {
  // `claude mcp list` prints one server per line as "name: url ...".
  const r = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null; // claude CLI missing / errored
  return /(^|\n)\s*mcpbox\b/.test(r.stdout);
}

async function cmdMode(rest) {
  const [arg] = rest;
  if (!arg || arg === "--show") {
    process.stdout.write(`mcpbox pipeline mode: ${readMode()} (${MODES.join(" | ")})\n`);
    return;
  }
  const m = await writeMode(arg); // throws on invalid → caught by main().catch
  process.stdout.write(`✓ mcpbox pipeline mode: ${m}\n`);
}

// Pairs this machine with a workspace so hooks can put its project knowledge
// into new sessions (lib/cloud-knowledge.mjs). The token stays in
// ~/.agents/mcpbox/credentials.json, readable by this user only.
async function cmdLogin(rest) {
  const i = rest.indexOf("--base-url");
  const baseUrl = i !== -1 ? rest[i + 1] : undefined;
  if (i !== -1 && (!baseUrl || baseUrl.startsWith("--"))) throw new Error("--base-url needs a value");
  const creds = await login(baseUrl ? { baseUrl } : {});
  process.stdout.write(`✓ Paired with workspace ${creds.workspace_id}; token in ${credentialsPath()}\n`);
}

async function cmdLogout() {
  await logout();
  process.stdout.write(
    `✓ Removed ${credentialsPath()}\n` +
      "The token itself stays valid until revoked in the workspace settings (Tokens).\n",
  );
}

async function cmdDoctor(rest) {
  const json = rest.includes("--json");
  const flags = rest.filter((a) => a !== "--json");
  const { projectDir } = parseDirFlag(flags);

  const hierarchy = await policyHierarchy({ projectDir });
  const policy = hierarchy.present;
  const mcp = mcpServerPresent();
  const ready = policy && !hierarchy.duplicate && mcp === true;
  // Which server text this machine holds and when it last asked; blocks are
  // compared with that copy, the baked text only when none was ever fetched.
  const served = {};
  for (const surface of ["claude", "plain"]) {
    const { etag, body, fetchedAt, checkedAt, failedAt } = await readPolicyCache(surface);
    const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
    served[surface] = typeof etag === "string" && typeof body === "string"
      ? { etag, fetched_at: iso(fetchedAt), checked_at: iso(checkedAt), failed_at: iso(failedAt), body }
      : null;
  }
  const claudeBlock = served.claude ? versionedBlock(served.claude.body) : BLOCK_BODY;
  const plainBlock = served.plain ? versionedBlock(served.plain.body) : BLOCK_BODY_PLAIN;
  const policyServer = Object.fromEntries(Object.entries(served).map(([k, v]) => {
    if (!v) return [k, null];
    const { body: _, ...meta } = v;
    return [k, meta];
  }));
  // Stale is a warning, not NOT READY: the next SessionStart refreshes it.
  const stale = await stalePolicyPaths(hierarchy.paths, claudeBlock);
  // Codex carriers (no Codex hooks exist): AGENTS.md up the tree and the user skill.
  const agents = await policyHierarchy({ projectDir, file: "AGENTS.md" }).catch(() => ({ paths: [] }));
  const agentsStale = await stalePolicyPaths(agents.paths, plainBlock);
  const skill = await syncCodexSkill({ dryRun: true, block: plainBlock }).catch(() => ({ action: "missing" }));
  const skillStale = skill.action === "stale" ? [skill.path] : [];
  // Cursor rules up the tree carry the same plain text.
  const cursorStale = await syncCursorRules({ cwd: resolve(projectDir ?? process.cwd()), block: plainBlock, dryRun: true });
  // Also a warning: two policies in one file, one of them from the daruma CLI.
  const competing = await competingPolicyPaths({ projectDir });
  // Not required: without it hooks hint at the knowledge instead of loading it.
  const paired = (await readCredentials()) !== null;

  if (json) {
    process.stdout.write(JSON.stringify({
      ready, policy, mcp,
      policy_paths: hierarchy.paths,
      policy_duplicate: hierarchy.duplicate,
      policy_stale: stale.length > 0,
      policy_stale_paths: stale,
      policy_competing_paths: competing,
      agents_md_paths: agents.paths,
      agents_md_stale_paths: agentsStale,
      codex_skill_stale_paths: skillStale,
      cursor_rule_stale_paths: cursorStale,
      knowledge_paired: paired,
      policy_server: policyServer,
    }) + "\n");
  } else {
    const mark = (v) => (v === true ? "✓" : v === false ? "✗" : "?");
    process.stdout.write(
      `mcpbox MCP server: ${mark(mcp)}${mcp === null ? " (claude CLI not found)" : ""}\n` +
        `CLAUDE.md policy:  ${mark(policy)}${hierarchy.duplicate ? " (duplicate managed blocks)" : ""}\n` +
        hierarchy.paths.map((p) => `  ${p}${stale.includes(p) ? " (stale — the next session start of this plugin version refreshes it)" : ""}\n`).join("") +
        Object.entries(policyServer).map(([surface, meta]) => meta
          ? `  server text (${surface}): ETag ${meta.etag}, fetched ${meta.fetched_at ?? "?"}, checked ${meta.checked_at ?? "?"}${meta.failed_at ? `, last failure ${meta.failed_at}` : ""}\n`
          : `  server text (${surface}): not fetched yet — blocks carry plugin ${VERSION} text\n`).join("") +
        (agents.paths.length ? `AGENTS.md policy:  ✓\n` : "") +
        agents.paths.map((p) => `  ${p}${agentsStale.includes(p) ? " (stale — run: mcpbox-claude codex-init)" : ""}\n`).join("") +
        skillStale.map((p) => `  ${p} (stale — run: mcpbox-claude codex-init)\n`).join("") +
        cursorStale.map((p) => `  ${p} (stale — run: mcpbox-claude cursor-init)\n`).join("") +
        competing.map((p) => `  ! ${p} also holds a daruma CLI policy block — keep one\n`).join("") +
        `Project knowledge: ${paired ? "✓ paired" : "hint only — run: npx -y @mcpbox/mcpbox-claude login"}\n` +
        `${ready ? "READY" : "NOT READY — run: npx @mcpbox/mcpbox setup"}\n`
    );
  }
  process.exit(ready ? 0 : 1);
}

// The marketplace repo is private, so `claude plugin marketplace add
// tupical/mcpbox.ru` only resolves for users with access to it. This package is
// public and carries .claude-plugin/marketplace.json, so it can be the
// marketplace itself — but Claude Code reads a directory marketplace in place
// rather than copying it, and npx unpacks us into a disposable cache. Mirror
// the package to a stable path first.
async function cmdExportMarketplace(rest) {
  const { projectDir } = parseDirFlag(rest);
  const source = resolve(__dirname, "..");
  const target = resolve(projectDir ?? join(homedir(), ".agents", "mcpbox", "marketplace"));
  if (existsSync(target) && !existsSync(join(target, ".claude-plugin", "marketplace.json"))) {
    throw new Error(`${target} exists and is not an mcpbox marketplace — refusing to overwrite it`);
  }
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  process.stdout.write(`${target}\n`);
}

async function cmdGitHook(rest) {
  const [action = "install", ...flags] = rest;
  const dir = parseDirFlag(flags).projectDir ?? process.cwd();
  if (action === "install") {
    const r = await installGitHook(dir);
    process.stdout.write(r.installed ? `installed ${r.path}\n` : `skipped ${r.path}: ${r.reason}\n`);
    if (!r.installed) process.exitCode = 1;
  } else if (action === "uninstall") {
    const r = await removeGitHook(dir);
    process.stdout.write(r.removed ? `removed ${r.path}\n` : `nothing to remove at ${r.path}\n`);
  } else {
    throw new Error(`git-hook: unknown action ${action} (install|uninstall)`);
  }
}

async function main(argv) {
  const [, , cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-v":
      process.stdout.write(pkg.version + "\n");
      return;
    case "init":
      return cmdInit(rest);
    case "uninit":
      return cmdUninit(rest);
    case "codex-init":
      return cmdCodexInit(rest);
    case "codex-uninit":
      return cmdCodexUninit(rest);
    case "cursor-init":
      return cmdCursorInit(rest);
    case "cursor-uninit":
      return cmdCursorUninit(rest);
    case "kimi-init":
      return cmdKimiInit(rest);
    case "kimi-uninit":
      return cmdKimiUninit(rest);
    case "opencode-init":
      return cmdOpencodeInit(rest);
    case "opencode-uninit":
      return cmdOpencodeUninit(rest);
    case "codex-policy":
      return cmdCodexPolicy(rest);
    case "codex-skill":
      return cmdCodexSkill();
    case "codex-skill-retire":
      return cmdCodexSkillRetire();
    case "cursor-policy":
      return cmdCursorPolicy(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout();
    case "mode":
      return cmdMode(rest);
    case "git-hook":
      return cmdGitHook(rest);
    case "prepare-commit-msg":
      // The git hook shim's fallback when the plugin path moved; never fails a commit.
      await prepareCommitMsg({ messageFile: rest[0] }).catch(() => {});
      return;
    case "export-marketplace":
      return cmdExportMarketplace(rest);
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv).catch((err) => {
  process.stderr.write(`mcpbox-claude: ${err.stack ?? err.message ?? err}\n`);
  process.exit(1);
});
