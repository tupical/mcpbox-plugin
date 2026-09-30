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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  KNOWLEDGE_BUDGET,
  KNOWLEDGE_KINDS,
  fetchProjectKnowledge,
  formatKnowledge,
  readCredentials,
} from "../lib/cloud-knowledge.mjs";
import { SESSION_MARKERS, readStdin, sessionMarker } from "../lib/hook-input.mjs";
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
    hint: "[mcpbox] Detected pipeline intent → if this is raw input to mature: /mcpbox:pipeline-run or mcpbox_pipeline_run. Decided work that only mentions the pipeline follows the normal routing rule.",
  },
  {
    // create / import — ACTION + task/issue OBJECT (avoids bare-verb false positives).
    re: /\b(add|create|new|log|move|import)\s+(a\s+|an\s+)?(task|issue|ticket|subtask)\b|(?<![а-яёА-ЯЁ])(добавь|добавить|заведи|завести|создай|создать)\s+(задачу|таск|подзадачу|тикет)(?![а-яёА-ЯЁ])|(?<![а-яёА-ЯЁ])(перенеси|перенести|импортируй|заведи)\s+(ишью|задачу|таск|тикет|issue)(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected task-intake/import intent → daruma_plan_materialize (tasks are created only with a plan; an external issue is its source — plan.source.ref = the issue URL, not a second tracker). Adding to an EXISTING plan: still materialize (no bare-task intake), then attach via daruma_plan_add_task (recompose) or pass parent_plan_id. Not a lookup — don't treat the id as an existing task.",
  },
  {
    // "Создай план" / "make a plan": the plan goes to mcpbox, not into chat.
    // Bare "распланируй" plans vacations too — only with a work object.
    re: /\b(make|write|create)\s+(a\s+|the\s+)?plan\b|(?<![а-яёА-ЯЁ])((созда(й|йте|ть)|напиши(те)?|написать|состав(ь|ьте|ить))\s+план|распланируй\s+(задачи|работу|релиз|спринт|миграцию|проект|итерацию))(?![а-яёА-ЯЁ])/,
    hint: "[mcpbox] Detected plan request → decided work: daruma_plan_materialize first (plan.source = issue URL or chat label), then reply with a short summary and the plan id; never a plan only in chat. Raw idea / undecided direction: mcpbox_pipeline_run.",
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
  {
    // An issue from an external tracker — its URL, or `#N` next to the word
    // issue/ticket/work item/задача. An agent once took a GitLab issue for a
    // "second tracker" and recorded no plan at all. A bare `#123` is not one.
    // Last: "close issue #42" / "status of issue #12" keep their own intent.
    re: /https?:\/\/\S+?\/(issues|work_items)\/(\d+|[a-z][a-z0-9_]*-\d+)|https?:\/\/\S+?\/browse\/[a-z][a-z0-9_]*-\d+|(\b(issue|ticket|work\s*item)\b|(?<![а-яёА-ЯЁ])(ишью|тикет|задач[а-яё]*)(?![а-яёА-ЯЁ]))[\s:]*#\d+(?!\w)|#\d+(?!\w)[\s:]*(\b(issue|ticket|work\s*item)\b|(?<![а-яёА-ЯЁ])(ишью|тикет|задач[а-яё]*)(?![а-яёА-ЯЁ]))/,
    hint: "[mcpbox] Detected an external issue/work item → if you'll work on it, it is the SOURCE of the request, not a second tracker: daruma_plan_materialize with plan.source.ref = the issue URL, then daruma_plan_drain_next → daruma_complete; decisions → mcpbox_knowledge_write. Only reading/answering about it records nothing.",
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
  "[mcpbox:full] " + OPERATIONAL_EXIT + "assess rawness: only raw material — an idea, hypothesis, or undecided direction — goes to mcpbox_pipeline_run. Work that is already decided and bounded, and follow-up work extending a run that has already handed off (it has a task_id), both go straight to daruma via daruma_plan_materialize. A run still in flight is not a shortcut — finish it first.";

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

// Whether this is the session's first prompt, claimed once through an empty
// marker file per session (`wx` fails when the marker already exists).
// Without a session id there is no "first": callers treat it as not first.
// Markers older than a week are swept on each successful claim, so the
// directory stays bounded however many sessions run.
const MARKER_TTL_MS = 7 * 24 * 3600 * 1000;

function sweepMarkers(dir) {
  const now = Date.now();
  readdir(dir)
    .then((names) => Promise.all(names.map(async (name) => {
      const marker = join(dir, name);
      if (now - (await stat(marker)).mtimeMs > MARKER_TTL_MS) await rm(marker, { force: true });
    }).map((p) => p.catch(() => {}))))
    .catch(() => { /* best effort */ });
}

export async function claimFirstPrompt(payload) {
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return false;
  const dir = SESSION_MARKERS();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(sessionMarker(sessionId), "", { flag: "wx" });
  } catch {
    return false;
  }
  // Off the critical path: the prompt does not wait for the sweep.
  sweepMarkers(dir);
  return true;
}

// Kimi never fires SessionStart (its hook block registers it, but the event
// does not arrive) and it reads AGENTS.md from the working directory ONLY —
// no walk up the tree, no user-level instruction file. A globally-installed
// policy therefore sits in ~/AGENTS.md where no real project sees it, and the
// agent answers "no such command" to `mcpbox mode`. UserPromptSubmit does
// fire, so for Kimi the policy rides in on the first prompt of a session.
// Claude registers this hook without --policy: it reads CLAUDE.md already.
async function policyForPrompt(payload, firstPrompt) {
  if (!process.argv.includes("--policy")) return "";
  // PLAIN: this path only ever serves non-Claude surfaces, which have no
  // /mcpbox:* commands.
  const { BLOCK_BODY_PLAIN, BEGIN } = await import("../lib/policy.mjs");
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  try {
    // An AGENTS.md right here already carries the block — the agent is
    // reading it, so a second copy would be pure noise.
    if ((await readFile(join(cwd, "AGENTS.md"), "utf8")).includes(BEGIN)) return "";
  } catch { /* no AGENTS.md here — the policy has to come from us */ }
  // No session id: the policy repeats on every prompt rather than never.
  return firstPrompt || !payload?.session_id ? BLOCK_BODY_PLAIN : "";
}

// Project knowledge is read only when the agent is told to, next to the
// question, with a call it can make as is (measured 2026-09-27, ADR-0010 D4:
// the same three repo questions, 6/6 right when told to read vs 1/5 as
// usual; a policy line alone was ignored). The hook knows the repo path, not
// the project, so the call resolves the project by scope_path.
export function knowledgeHint(cwd, { relogin = false } = {}) {
  const call = JSON.stringify({ scope: "project", scope_path: cwd, kinds: KNOWLEDGE_KINDS, budget: KNOWLEDGE_BUDGET });
  const hint = `[mcpbox] Before answering or changing anything in this repo, read its project knowledge (rules its files do not carry): mcpbox_knowledge_read ${call}. If no project is bound to this path, go on without it.`;
  return relogin
    ? `${hint} (The pairing token was rejected — tell the user to run: npx -y @mcpbox/mcpbox-claude login)`
    : hint;
}

// Paired (`mcpbox-claude login`): the knowledge text itself. Not paired, the
// read failed, or the path is unbound in the paired workspace (the client's
// own MCP session may be in another one): the ready call as a hint. No rows
// for a bound project: nothing.
export async function knowledgeForSession(cwd, { fetchKnowledge = fetchProjectKnowledge, creds } = {}) {
  const auth = creds === undefined ? await readCredentials() : creds;
  if (!auth) return knowledgeHint(cwd);
  try {
    const result = await fetchKnowledge(cwd, { creds: auth });
    if (!result || result.unbound_scope_path) return knowledgeHint(cwd);
    return formatKnowledge(result);
  } catch (err) {
    return knowledgeHint(cwd, { relogin: Boolean(err?.rejected) });
  }
}

async function main() {
  // Always read the event: session_id and cwd live only there, even when
  // Claude Code also exports the prompt as CLAUDE_USER_PROMPT.
  let payload = null;
  // The env var already gave the prompt: wait for the event only briefly.
  const raw = await readStdin(process.env.CLAUDE_USER_PROMPT ? 300 : 3000);
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch { /* not JSON — no event to read */ }
  }
  const prompt = process.env.CLAUDE_USER_PROMPT ?? (payload ? promptFromHookPayload(payload) : "");
  const mode = readMode();
  const firstPrompt = await claimFirstPrompt(payload);
  const policy = await policyForPrompt(payload, firstPrompt);
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : "";
  // In parallel: both are network calls on the session's first prompt.
  const [knowledge, update] = await Promise.all([
    firstPrompt && cwd && mode !== "off" ? knowledgeForSession(cwd) : "",
    firstPrompt && policy ? checkForUpdate({ current: VERSION }) : null,
  ]);
  const hint = promptSubmitHint(prompt, mode);
  const notice = update?.outdated ? updateNotice(update.current, update.latest, "kimi") : "";
  // One write, not two: Codex parses stdout as a single JSON document, so a
  // policy object followed by a hint object is as invalid as plain text.
  writeHookOutput(
    "UserPromptSubmit",
    [notice, policy, knowledge, hint].filter(Boolean).join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
