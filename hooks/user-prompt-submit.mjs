#!/usr/bin/env node
// UserPromptSubmit hook: detect capture / sync / status / close / pipeline
// intent in the user's prompt and prepend a short routing hint so the agent
// routes to the right place rather than improvising. The /mcpbox:* commands
// exist only in Claude Code, so each hint names the MCP tool as well — Codex,
// Cursor and Kimi can act on the hint without the plugin.
//
// Output goes to stdout — Claude Code injects it as a <system-reminder>; Kimi
// Code appends it to the context on exit 0. Exit 0 always; this hook must
// never block a prompt from being submitted.
//
// Prompt source: CLAUDE_USER_PROMPT env var (Claude Code); otherwise the hook
// event JSON on stdin (Kimi Code passes the payload via stdin, and so does
// Claude Code — this also covers Claude setups without the env var).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeHookOutput } from "../lib/hook-output.mjs";
import { readMode } from "../lib/mode.mjs";
import { checkForUpdate, updateNotice } from "../lib/update-check.mjs";
import { VERSION } from "../lib/version.mjs";

// Intent patterns. Order matters — first match wins. ASCII keywords use \b;
// Cyrillic uses whitespace/edge guards since \b is ASCII-only.
// PATTERNS[0] is the pipeline pattern — mode "off" drops it (see promptSubmitHint).
const PATTERNS = [
  {
    re: /\b(pipeline|maturity|handoff|action\s*packet)\b|(?<![а-яёА-ЯЁ])(пайплайн|конвейер|зрелость|хендофф)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected pipeline intent → if this is raw input to mature: /mcpbox:pipeline-run or mcpbox_pipeline_run (torii→…→fujin→handoff). Decided work that only mentions the pipeline follows the normal routing rule.",
  },
  {
    // create / import — ACTION + task/issue OBJECT (avoids bare-verb false positives).
    re: /\b(add|create|new|log|move|import)\s+(a\s+|an\s+)?(task|issue|ticket|subtask)\b|(?<![а-яёА-ЯЁ])(добавь|добавить|заведи|завести|создай|создать)\s+(задачу|таск|подзадачу|тикет)(?![а-яёА-ЯЁ])|(?<![а-яёА-ЯЁ])(перенеси|перенести|импортируй|заведи)\s+(ишью|задачу|таск|тикет|issue)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected task-intake/import intent → daruma_plan_materialize (plan-only intake, ADR-0007; external issue: also daruma_link the source). Adding to an EXISTING plan: still materialize (no bare-task intake), then attach via daruma_plan_add_task (recompose) or pass parent_plan_id. Not a lookup — don't treat the id as an existing task.",
  },
  {
    re: /\b(list|show|view)\s+(all\s+|active\s+|open\s+)?(tasks|issues|backlog)\b|(?<![а-яёА-ЯЁ])(выпиши|покажи|перечисли|список)\s+(активные\s+)?(задачи|задач|таски|бэклог)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected task-list intent → /mcpbox:tasks in Claude, otherwise daruma_list status=active with a scope.",
  },
  {
    re: /\b(capture|record|lesson)\b|(?<![а-яёА-ЯЁ])(сохрани|запомни|урок)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected lesson-capture intent → /mcpbox:capture in Claude, otherwise persist it with mcpbox_knowledge_write.",
  },
  {
    re: /\b(sync|refresh\s+tasks)\b|(?<![а-яёА-ЯЁ])(синх|обнови\s+задачи)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected sync intent → /mcpbox:sync in Claude, otherwise re-read state with daruma_list / daruma_plan_get.",
  },
  {
    re: /\b(status|progress|what.?s\s+(open|next|left))\b|(?<![а-яёА-ЯЁ])(статус|прогресс|что\s+(открыто|осталось|дальше))(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected status query → if this is about mcpbox/daruma: /mcpbox:status in Claude, otherwise daruma_workspace_info + daruma_list status=active + mcpbox_runs_list.",
  },
  {
    re: /\b(close|complete|mark\s+.*done)\b|(?<![а-яёА-ЯЁ])(закрой|закрыть|завершить|пометь\s+.*выполненной)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected close intent → if this refers to a daruma task: /mcpbox:close in Claude, otherwise daruma_complete (or daruma_set_status).",
  },
];

// full mode: remind the agent to judge rawness itself — a regex can't. Only
// fires on substantive prompts that didn't already match an explicit intent.
// The exit comes FIRST. When this hint led with "assess for rawness", an agent
// asked to start a dev server announced a Daruma follow-up and went looking for
// ceremony: the routing rule offered three doors and every one of them ended in
// a tracker artifact, so there was no branch that said "just do it".
// A routing hint fires on the first PATTERNS match, so an operational request
// that happens to contain a keyword never reached the exit below: "запусти
// сервер и закрой лишние процессы" matched the close pattern and pointed a pure
// process restart at daruma_complete — the incident again, wearing another verb.
// In full mode every hint therefore carries the exit in front of it.
const OPERATIONAL_EXIT =
  "If this is an operational action you can just carry out — start/restart something, read a log, check status, open a file, answer a question — do it and record nothing, in neither daruma nor the pipeline. Otherwise: ";

const FULL_ASSESS_HINT =
  "[mcpbox:full] " + OPERATIONAL_EXIT + "assess rawness: only raw material — an idea, hypothesis, or undecided direction — matures through the pipeline (mcpbox_pipeline_run → …fujin → handoff). Work that is already decided and bounded, and follow-up work extending a run that has already handed off (it has a task_id), both go straight to daruma via daruma_plan_materialize. A run still in flight is not a shortcut — finish it first.";

// ponytail: length heuristic for "substantive" — cheap and good enough to skip
// "ok"/"yes"/"go". Swap for a token/keyword check only if it nags in practice.
const SUBSTANTIVE_MIN = 40;

export function promptSubmitHint(promptText = "", mode = "lite") {
  // Strip fenced code blocks so a keyword pasted inside ``` … ``` doesn't
  // trigger a routing hint (OMC-style false-positive guard, kept minimal —
  // these hints are low-stakes suggestions, not mode activation).
  const prompt = promptText.replace(/```[\s\S]*?```/g, " ").toLowerCase().trim();
  const patterns = mode === "off" ? PATTERNS.slice(1) : PATTERNS;
  for (const { re, hint } of patterns) {
    if (re.test(prompt)) {
      // A keyword match is a guess about intent, not a verdict on it — in full
      // mode the operational exit goes ahead of the guess.
      return mode === "full" ? `[mcpbox:full] ${OPERATIONAL_EXIT}${hint}` : hint;
    }
  }
  if (mode === "full" && prompt.length >= SUBSTANTIVE_MIN) return FULL_ASSESS_HINT;
  return "";
}

// Reads stdin to EOF with a timeout so a hook caller that keeps stdin open
// can never hang the prompt submit path.
function readStdin(timeoutMs = 3000) {
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

// Kimi's UserPromptSubmit payload carries the prompt text; the exact field
// name is not documented, so accept the common shapes. Kimi sends it as an
// array of content blocks — `prompt: [{type: "text", text: "…"}]` — which the
// string-only lookup missed, so every routing hint stayed silent there.
export function promptFromHookPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["prompt", "user_prompt", "userPrompt", "message", "text"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const text = value
        .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
        .filter((part) => typeof part === "string" && part.trim())
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return "";
}

// Kimi never fires SessionStart (its hook block registers it, but the event
// does not arrive) and it reads AGENTS.md from the working directory ONLY —
// no walk up the tree, no user-level instruction file. A globally-installed
// policy therefore sits in ~/AGENTS.md where no real project sees it, and the
// agent answers "no such command" to `mcpbox mode`. UserPromptSubmit does
// fire, so for Kimi the policy rides in on the first prompt of a session.
// Claude registers this hook without --policy: it reads CLAUDE.md already.
async function policyForFirstPrompt(payload) {
  if (!process.argv.includes("--policy")) return { policy: "", firstPrompt: false };
  // PLAIN: this path only ever serves non-Claude surfaces, which have no
  // /mcpbox:* commands.
  const { BLOCK_BODY_PLAIN, BEGIN } = await import("../lib/policy.mjs");
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  let policy = BLOCK_BODY_PLAIN;
  try {
    // An AGENTS.md right here already carries the block — the agent is
    // reading it, so a second copy would be pure noise.
    if ((await readFile(join(cwd, "AGENTS.md"), "utf8")).includes(BEGIN)) policy = "";
  } catch { /* no AGENTS.md here — the policy has to come from us */ }

  if (!policy) return { policy: "", firstPrompt: false };
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return { policy, firstPrompt: false }; // policy repeats; update notices must not
  // ponytail: one empty marker file per session, never swept. They are 0
  // bytes; add a cleanup pass only if a long-lived install ever complains.
  const marker = join(homedir(), ".agents", "mcpbox", "sessions", sessionId.replace(/[^\w.-]/g, "_"));
  try {
    await mkdir(dirname(marker), { recursive: true });
    // wx fails if it exists → the policy already went out this session.
    await writeFile(marker, "", { flag: "wx" });
  } catch {
    return { policy: "", firstPrompt: false };
  }
  return { policy, firstPrompt: true };
}

async function main() {
  let prompt = process.env.CLAUDE_USER_PROMPT ?? "";
  let payload = null;
  if (!prompt) {
    const raw = await readStdin();
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
        prompt = promptFromHookPayload(payload);
      } catch { /* not JSON — no prompt to route */ }
    }
  }
  const { policy, firstPrompt } = await policyForFirstPrompt(payload);
  const update = firstPrompt ? await checkForUpdate({ current: VERSION }) : null;
  const hint = promptSubmitHint(prompt, readMode());
  const notice = update?.outdated ? updateNotice(update.current, update.latest, "kimi") : "";
  // One write, not two: Codex parses stdout as a single JSON document, so a
  // policy object followed by a hint object is as invalid as plain text.
  writeHookOutput(
    "UserPromptSubmit",
    [notice, policy, hint].filter(Boolean).join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
