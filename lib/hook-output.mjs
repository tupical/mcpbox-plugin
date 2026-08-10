// One writer for every hook's stdout, because the surfaces disagree on format.
//
// Claude Code and Kimi normally take plain text. Codex parses hook stdout as
// JSON; Claude also accepts JSON when a user-visible systemMessage is present.
//
// Codex is the surface that exports PLUGIN_DATA (its per-plugin state dir,
// ~/.codex/plugins/data/<marketplace>-<plugin>); Claude Code exports only
// CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA, so a bare PLUGIN_DATA identifies Codex.
export function isCodexSurface(env = process.env) {
  return Boolean(env.PLUGIN_DATA);
}

// Codex has a *HookSpecificOutputWire for SessionStart / UserPromptSubmit /
// SubagentStart only; Stop has none and rejects additionalContext there, so a
// Stop message rides as systemMessage instead.
/** @param {{ systemMessage?: string }} [options] */
export function hookOutputPayload(event, text, options = {}) {
  const systemMessage = options?.systemMessage;
  const hasSystemMessage = systemMessage !== undefined;
  if (event === "Stop" || event === "SubagentStop") {
    return { systemMessage: systemMessage ?? text };
  }
  return {
    ...(hasSystemMessage ? { systemMessage } : {}),
    ...(text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {}),
  };
}

// Empty output stays empty: every surface reads "no stdout" as "no hint", and
// Codex only parses when something was written.
/** @param {{ systemMessage?: string }} [options] */
export function writeHookOutput(event, text, options = {}, env = process.env) {
  const systemMessage = options?.systemMessage;
  const hasSystemMessage = systemMessage !== undefined;
  if (!text && !hasSystemMessage) return;
  if (!hasSystemMessage && !isCodexSurface(env)) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(hookOutputPayload(event, text, { systemMessage }))}\n`);
}
