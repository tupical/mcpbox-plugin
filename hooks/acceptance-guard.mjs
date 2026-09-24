#!/usr/bin/env node
// Integrity check, not an OS sandbox. The controller pins the baseline before execution.
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync, writeSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export function checkAcceptanceLock(lock, event = {}) {
  if (!lock || typeof lock.repo !== "string" || !isAbsolute(lock.repo)
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(lock.base)
      || !Array.isArray(lock.paths) || !lock.paths.length) {
    throw new Error("invalid acceptance lock: expected absolute repo, immutable commit SHA and paths");
  }
  const repo = realpathSync(lock.repo);
  const gitEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];
  const git = (args) => execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: repo, timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Do not allow Git environment overrides to redirect the baseline lookup.
  if (realpathSync(git(["rev-parse", "--show-toplevel"]).toString().replace(/\r?\n$/, "")) !== repo) {
    throw new Error("acceptance repo must be the Git root");
  }
  for (const path of lock.paths) {
    if (typeof path !== "string" || !path || isAbsolute(path)
        || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("acceptance paths must be normalized repository-relative files");
    }
    const file = resolve(repo, path);
    const actual = realpathSync(file);
    const rel = relative(repo, actual);
    if (rel.startsWith("../") || isAbsolute(rel) || actual !== file || !lstatSync(file).isFile()) {
      throw new Error(`protected assertion must be a regular file without symlink traversal: ${path}`);
    }
    if (!readFileSync(file).equals(git(["show", `${lock.base}:${path}`]))) {
      throw new Error(`protected assertion changed: ${path}`);
    }
    if (event.hook_event_name === "PreToolUse" && ["Edit", "Write", "MultiEdit"].includes(event.tool_name)) {
      const target = event.tool_input?.file_path ?? event.tool_input?.path;
      if (typeof target === "string" && resolve(event.cwd ?? repo, target) === file) {
        throw new Error(`executor cannot edit protected assertion: ${path}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.MCPBOX_ACCEPTANCE_LOCK) {
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        // Hook transports may keep stdin open after the JSON message.
        try { JSON.parse(input); break; } catch { /* await the remaining JSON */ }
      }
      checkAcceptanceLock(JSON.parse(process.env.MCPBOX_ACCEPTANCE_LOCK), input.trim() ? JSON.parse(input) : {});
    } catch (error) {
      writeSync(2, `[mcpbox/acceptance-integrity] ${error.message}\nStop execution; record an integrity warning in Daruma. Do not rebaseline the oracle to obtain PASS.\n`);
      process.exitCode = 2;
    }
  }
}
