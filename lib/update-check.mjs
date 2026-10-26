import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASE_URL, normalizeBaseUrl, readCredentials } from "./cloud-knowledge.mjs";
import { BLOCK_BODY, BLOCK_BODY_PLAIN, versionedBlock } from "./policy.mjs";
import { VERSION } from "./version.mjs";

const REGISTRY_URL = "https://registry.npmjs.org/@mcpbox/mcpbox-claude";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1000;

export function compareVersions(left, right) {
  const clean = (value) => String(value).split("-")[0];
  const a = clean(left);
  const b = clean(right);
  if (!/^\d+(?:\.\d+)*$/.test(a) || !/^\d+(?:\.\d+)*$/.test(b)) return null;
  const leftSegments = a.split(".").map(Number);
  const rightSegments = b.split(".").map(Number);
  for (let i = 0; i < Math.max(leftSegments.length, rightSegments.length); i += 1) {
    const difference = (leftSegments[i] ?? 0) - (rightSegments[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export async function checkForUpdate({
  current,
  home = homedir(),
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (process.env.MCPBOX_NO_UPDATE_CHECK) return null;
  const cacheFile = join(home, ".agents", "mcpbox", "update-check.json");
  /** @type {{ checkedAt?: number, failedAt?: number, latest?: string } | null} */
  let cached = null;
  try {
    try {
      cached = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch { /* missing or invalid cache — check the registry */ }

    if (
      typeof cached?.latest === "string"
      && Number.isFinite(cached?.checkedAt)
      && Date.now() - cached.checkedAt < ttlMs
    ) {
      const comparison = compareVersions(current, cached.latest);
      return comparison === null
        ? null
        : { current, latest: cached.latest, outdated: comparison < 0 };
    }
    if (Number.isFinite(cached?.failedAt) && Date.now() - cached.failedAt < FAILED_TTL_MS) return null;

    const response = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`registry returned ${response.status}`);
    const latest = (await response.json())?.["dist-tags"]?.latest;
    const comparison = compareVersions(current, latest);
    if (typeof latest !== "string" || comparison === null) throw new Error("invalid registry version");
    await writeCache(cacheFile, { checkedAt: Date.now(), latest }).catch(() => {});
    return { current, latest, outdated: comparison < 0 };
  } catch {
    await writeCache(cacheFile, { ...(cached ?? {}), failedAt: Date.now() }).catch(() => {});
    return null;
  }
}

// The managed policy block as the server holds it now (GET /v1/policy/{surface}).
// Invalidation is the ETag alone: every call is one conditional request, and
// 304 means nothing is downloaded — no TTL guessing which copy is fresh.
// Failures back off for FAILED_TTL_MS and fall back to the last copy (an old
// copy beats none); null means no server copy was ever seen, so the caller
// writes the text baked into the plugin. MCPBOX_NO_POLICY_FETCH=1 opts out.
// One cache file per surface: the hook fetches both surfaces at once.
// Result: { surface, etag, body, fetchedAt, checkedAt, source }, where source is
// "server" (downloaded), "server-unchanged" (304) or "cache" (server unreachable).
const POLICY_MAX_BYTES = 64 * 1024;

export function policyCachePath(surface, home = homedir()) {
  return join(home, ".agents", "mcpbox", `policy-${surface}.json`);
}

// A served body must fit between the managed markers and carry no version
// line of its own (the writing plugin adds it).
function acceptablePolicyBody(body) {
  return typeof body === "string"
    && body.trim().length > 0
    && Buffer.byteLength(body) <= POLICY_MAX_BYTES
    && !body.includes("<!-- mcpbox:policy:")
    && !body.includes("<!-- mcpbox-claude:policy-version");
}

export async function readPolicyCache(surface, home = homedir()) {
  try {
    const cached = JSON.parse(await readFile(policyCachePath(surface, home), "utf8"));
    return cached && typeof cached === "object" ? cached : {};
  } catch {
    return {};
  }
}

// The server copy already on disk, without asking the server; null if none.
function knownPolicy(surface, cached) {
  return typeof cached.etag === "string" && acceptablePolicyBody(cached.body)
    ? { surface, etag: cached.etag, body: cached.body, fetchedAt: cached.fetchedAt, checkedAt: cached.checkedAt }
    : null;
}

export async function cachedPolicyBody(surface, home = homedir()) {
  const known = knownPolicy(surface, await readPolicyCache(surface, home));
  return known && { ...known, source: "cache" };
}

export async function fetchPolicyBody(surface, {
  baseUrl = DEFAULT_BASE_URL,
  home = homedir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (process.env.MCPBOX_NO_POLICY_FETCH) return null;
  const cacheFile = policyCachePath(surface, home);
  const cached = await readPolicyCache(surface, home);
  const known = knownPolicy(surface, cached);
  const fallback = known && { ...known, source: "cache" };
  if (Number.isFinite(cached.failedAt) && Date.now() - cached.failedAt < FAILED_TTL_MS) return fallback;
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/policy/${surface}`, {
      headers: {
        Accept: "text/markdown",
        "X-Daruma-Plugin-Contract": "1",
        ...(known ? { "If-None-Match": known.etag } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const checkedAt = Date.now();
    let result;
    if (response.status === 304 && known) {
      result = { ...known, checkedAt, source: "server-unchanged" };
    } else if (response.status === 200) {
      const etag = response.headers.get("etag");
      const body = await response.text();
      if (!etag || !acceptablePolicyBody(body)) throw new Error("invalid policy response");
      result = { surface, etag, body, fetchedAt: checkedAt, checkedAt, source: "server" };
    } else {
      throw new Error(`policy returned ${response.status}`);
    }
    const { source: _, ...entry } = result;
    await writeCache(cacheFile, entry).catch(() => {});
    return result;
  } catch {
    await writeCache(cacheFile, { ...cached, failedAt: Date.now() }).catch(() => {});
    return fallback;
  }
}

// Block text every carrier writes — CLAUDE.md (claude), and AGENTS.md, the
// Codex SKILL.md and the Cursor .mdc (plain): the server's copy when one was
// ever fetched, else the text baked into this plugin. Three carriers, one
// text, the server wins. `fetch: false` (install commands) reads only the
// copy on disk: asking the server is the session start's job, and an install
// stays offline and deterministic. A paired machine asks the server it is
// paired with. `origin` names where the text came from.
export async function policyBlocks({ fetch = true, home = homedir() } = {}) {
  const baseUrl = fetch ? (await readCredentials())?.base_url ?? DEFAULT_BASE_URL : null;
  const [claude, plain] = await Promise.all(["claude", "plain"].map((surface) => (fetch
    ? fetchPolicyBody(surface, { baseUrl, home })
    : cachedPolicyBody(surface, home)).catch(() => null)));
  // Each surface's ETag: the plain carriers hold a different text than CLAUDE.md.
  const served = Object.entries({ claude, plain }).filter(([, copy]) => copy);
  return {
    claude: claude ? versionedBlock(claude.body) : BLOCK_BODY,
    plain: plain ? versionedBlock(plain.body) : BLOCK_BODY_PLAIN,
    origin: served.length
      ? `server policy ${served.map(([surface, copy]) => `${copy.etag} (${surface})`).join(", ")}`
      : `plugin ${VERSION}`,
  };
}

async function writeCache(cacheFile, value) {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(value)}\n`);
}

// Both plugin surfaces update from the git marketplace, not from the npm mirror
// that export-marketplace builds: Claude ignores autoUpdate on a directory
// source and Codex rejects a non-git one, so pointing a stale install back at
// the mirror would reinstate exactly the setup that could not auto-update.
// Reaching this notice on those two means the install predates the git
// marketplace — so the command re-points it, rather than refreshing in place.
// Older installers registered the npm mirror as a *directory* marketplace, and
// that declaration in settings.json makes a bare `marketplace add <git>` fail
// ("network source differs from the one declared"). `remove` drops both the
// declaration and the plugin, so add + install then land on the latest git
// release — from a directory install and from a git one alike. Safe with
// `&&`: the notice only fires when the plugin, hence its marketplace, exists.
const UPDATE_COMMANDS = Object.assign(Object.create(null), {
  claude: "claude plugin marketplace remove mcpbox && claude plugin marketplace add https://github.com/tupical/mcpbox-plugin.git && claude plugin install mcpbox-claude@mcpbox",
  codex: "codex plugin marketplace add https://github.com/tupical/mcpbox-plugin.git && codex plugin add mcpbox --marketplace mcpbox",
  kimi: "npx -y @mcpbox/mcpbox-claude@latest kimi-init",
});

export function updateNotice(current, latest, surface) {
  const command = UPDATE_COMMANDS[surface] ?? "npx -y @mcpbox/mcpbox-claude@latest";
  return `mcpbox ${current} → ${latest}.\nОбновить: ${command}`;
}
