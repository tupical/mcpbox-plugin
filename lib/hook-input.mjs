// Hook stdin and the per-session marker, shared by UserPromptSubmit (writes
// the marker on a session's first prompt) and Stop (reads its mtime as the
// session start).

import { homedir } from "node:os";
import { join } from "node:path";

// Reads stdin to EOF with a timeout so a hook caller that keeps stdin open
// can never hang the hook.
export function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let raw = "";
    const done = () => {
      clearTimeout(timer);
      resolve(raw);
    };
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(raw);
    }, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

export const SESSION_MARKERS = () => join(homedir(), ".agents", "mcpbox", "sessions");

export function sessionMarker(sessionId) {
  return join(SESSION_MARKERS(), sessionId.replace(/[^\w.-]/g, "_"));
}
