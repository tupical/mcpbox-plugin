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
import { installPolicy, removePolicy, policyHierarchy } from "../lib/policy.mjs";
import { installCodex, removeCodex, installCodexPolicy } from "../lib/codex.mjs";
import {
  installCursor,
  removeCursor,
  installCursorRule,
  installCursorModeCommand,
} from "../lib/cursor.mjs";
import { installKimi, removeKimi } from "../lib/kimi.mjs";
import { installOpencode, removeOpencode } from "../lib/opencode.mjs";
import { readMode, writeMode, MODES } from "../lib/mode.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const HELP = `mcpbox-claude v${pkg.version} — MCPBox agent harness (Claude / Codex / Cursor / Kimi / OpenCode)

Usage:
  mcpbox-claude init [--dir DIR]        Write the managed CLAUDE.md policy block
                                        (daruma tracker + full pipeline). Idempotent.
  mcpbox-claude uninit [--dir DIR]      Remove the managed CLAUDE.md policy block.
  mcpbox-claude codex-init [--dir DIR]  Write AGENTS.md policy, ~/.codex/config.toml
                                        [mcp_servers.mcpbox] and the mcpbox skill.
                                        Idempotent.
  mcpbox-claude codex-uninit [--dir DIR]
  mcpbox-claude cursor-init [--dir DIR] Write .cursor/rules/mcpbox-policy.mdc +
                                        .cursor/mcp.json mcpbox entry. Idempotent.
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
  mcpbox-claude mode [off|lite|full]    Get/set pipeline strictness (how raw ideas route).
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
};

async function cmdInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const r = await installPolicy({ projectDir });
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
  process.stdout.write("Open Claude Code in this directory to pick it up.\n");
}

async function cmdUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const r = await removePolicy({ projectDir });
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
}

function report(r) {
  process.stdout.write(`✓ ${VERB[r.action] ?? r.action} ${r.path}\n`);
}

async function cmdCodexInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, skill } = await installCodex({ projectDir });
  report(policy);
  report(mcp);
  report(skill);
}

async function cmdCodexUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { policy, mcp, skill, prompts } = await removeCodex({ projectDir });
  report(policy);
  report(mcp);
  report(skill);
  report(prompts);
}

async function cmdCursorInit(rest) {
  const { projectDir } = parseDirFlag(rest);
  const { rule, mcp, mode } = await installCursor({ projectDir });
  report(rule);
  report(mcp);
  report(mode);
}

async function cmdCursorUninit(rest) {
  const { projectDir } = parseDirFlag(rest);
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
  report(await installCodexPolicy({ projectDir }));
}

async function cmdCursorPolicy(rest) {
  const { projectDir } = parseDirFlag(rest);
  report(await installCursorRule({ projectDir }));
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

async function cmdDoctor(rest) {
  const json = rest.includes("--json");
  const flags = rest.filter((a) => a !== "--json");
  const { projectDir } = parseDirFlag(flags);

  const hierarchy = await policyHierarchy({ projectDir });
  const policy = hierarchy.present;
  const mcp = mcpServerPresent();
  const ready = policy && !hierarchy.duplicate && mcp === true;

  if (json) {
    process.stdout.write(JSON.stringify({ ready, policy, mcp, policy_paths: hierarchy.paths, policy_duplicate: hierarchy.duplicate }) + "\n");
  } else {
    const mark = (v) => (v === true ? "✓" : v === false ? "✗" : "?");
    process.stdout.write(
      `mcpbox MCP server: ${mark(mcp)}${mcp === null ? " (claude CLI not found)" : ""}\n` +
        `CLAUDE.md policy:  ${mark(policy)}${hierarchy.duplicate ? " (duplicate managed blocks)" : ""}\n` +
        hierarchy.paths.map((p) => `  ${p}\n`).join("") +
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
    case "cursor-policy":
      return cmdCursorPolicy(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "mode":
      return cmdMode(rest);
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
