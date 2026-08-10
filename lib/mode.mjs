// Pipeline strictness mode: how aggressively raw ideas get routed through the
// mcpbox maturity pipeline (torii→…→fujin→handoff) vs. tracked directly in daruma.
//
//   off   — no pipeline nudging; every request is treated as direct daruma work.
//   lite  — nudge toward the pipeline only when the input explicitly mentions it. (default)
//   full  — remind the agent to assess every substantive request for "rawness":
//           raw ideas mature through the pipeline; concrete bounded tasks go to daruma.
//
// The `mcpbox-claude mode` CLI writes it; hooks and the shared agent policy
// read it. The old Claude-only file remains a read fallback for upgrades.

import { promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MODES = ["off", "lite", "full"];
export const DEFAULT_MODE = "lite";

// ponytail: one shared file for every agent. Key it on cwd only if per-repo
// strictness is ever needed.
export const modeFile = (home = homedir()) => join(home, ".agents", "mcpbox", "mode");
const legacyModeFile = (home = homedir()) => join(home, ".claude", "mcpbox-mode");

export function readMode(home = homedir()) {
  for (const file of [modeFile(home), legacyModeFile(home)]) {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (MODES.includes(v)) return v;
    } catch {
      // missing / unreadable → try the legacy file, then default
    }
  }
  return DEFAULT_MODE;
}

export async function writeMode(mode, home = homedir()) {
  if (!MODES.includes(mode)) {
    throw new Error(`invalid mode "${mode}" — want one of: ${MODES.join(" | ")}`);
  }
  const file = modeFile(home);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, mode + "\n");
  return mode;
}
