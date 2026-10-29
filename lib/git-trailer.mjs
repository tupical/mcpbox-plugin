// Daruma-Task commit trailers: the git side of "closed from git" (T4).
// A commit names the task it serves, so CI on main can post the outcome and a
// deploy can complete it even when the agent dropped the task mid-way.
// Deterministic and offline: no tracker call happens at commit time.

import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionMarker } from "./hook-input.mjs";

export const TRAILER_KEY = "Daruma-Task";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BRANCH_RE = new RegExp(`^work/(${UUID})$`, "i");
const MANAGED = "# mcpbox-claude managed prepare-commit-msg";
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "prepare-commit-msg.mjs");

export function branchTaskId(branch) {
  return String(branch ?? "").trim().match(BRANCH_RE)?.[1].toLowerCase() ?? null;
}

// Successful claims recorded by track-claims.mjs, one JSON object per line.
export function claimedTaskIds(claimsText) {
  const ids = String(claimsText ?? "").split("\n").flatMap((line) => {
    try {
      const id = JSON.parse(line)?.task_id;
      return typeof id === "string" && new RegExp(`^${UUID}$`, "i").test(id) ? [id.toLowerCase()] : [];
    } catch { return []; }
  });
  return [...new Set(ids)];
}

// A work/<id> branch scopes the commit to that one task; elsewhere every task
// this session claimed is named (a session-wide commit on main, say).
export function commitTaskIds({ branch, claimsText }) {
  const fromBranch = branchTaskId(branch);
  return fromBranch ? [fromBranch] : claimedTaskIds(claimsText);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// git keeps an equal trailer once (addIfDifferent), so amend/re-run is a no-op.
export function addTrailers(messageFile, ids, cwd) {
  for (const id of ids) {
    git(["interpret-trailers", "--in-place", "--if-exists", "addIfDifferent",
      "--trailer", `${TRAILER_KEY}: ${id}`, messageFile], cwd);
  }
}

export async function prepareCommitMsg({ messageFile, cwd = process.cwd(), env = process.env }) {
  if (!messageFile) return [];
  let branch = "";
  try { branch = git(["symbolic-ref", "--short", "-q", "HEAD"], cwd); } catch { /* detached HEAD */ }
  const sessionId = env.CLAUDE_CODE_SESSION_ID || env.MCPBOX_SESSION_ID || "";
  const claimsText = sessionId
    ? await fs.readFile(`${sessionMarker(sessionId)}.claims`, "utf8").catch(() => "")
    : "";
  const ids = commitTaskIds({ branch, claimsText });
  if (ids.length) addTrailers(isAbsolute(messageFile) ? messageFile : resolve(cwd, messageFile), ids, cwd);
  return ids;
}

function hookPath(dir) {
  const path = git(["rev-parse", "--git-path", "hooks/prepare-commit-msg"], dir).trim();
  return isAbsolute(path) ? path : resolve(dir, path);
}

export function hookShim(script = HOOK_SCRIPT) {
  return [
    "#!/bin/sh",
    `${MANAGED}: appends Daruma-Task trailers; never blocks a commit.`,
    `hook='${script.replace(/'/g, "'\\''")}'`,
    'if [ -f "$hook" ]; then node "$hook" "$@"',
    'elif command -v mcpbox-claude >/dev/null 2>&1; then mcpbox-claude prepare-commit-msg "$@"; fi',
    "exit 0",
    "",
  ].join("\n");
}

function isManaged(path) {
  try { return readFileSync(path, "utf8").includes(MANAGED); } catch { return null; }
}

// Never replaces a hook someone else wrote.
export async function installGitHook(dir = process.cwd()) {
  const path = hookPath(dir);
  if (isManaged(path) === false) {
    return { path, installed: false, reason: "foreign prepare-commit-msg hook exists; leaving it alone" };
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, hookShim(), { mode: 0o755 });
  await fs.chmod(path, 0o755);
  return { path, installed: true };
}

export async function removeGitHook(dir = process.cwd()) {
  const path = hookPath(dir);
  if (isManaged(path) !== true) return { path, removed: false };
  await fs.rm(path);
  return { path, removed: true };
}
