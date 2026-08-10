import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

async function writeCache(cacheFile, value) {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(value)}\n`);
}

const UPDATE_COMMANDS = Object.assign(Object.create(null), {
  claude: "npx -y @mcpbox/mcpbox-claude@latest export-marketplace && claude plugin marketplace update mcpbox",
  codex: "npx -y @mcpbox/mcpbox-claude@latest export-marketplace && codex plugin add mcpbox --marketplace mcpbox",
  kimi: "npx -y @mcpbox/mcpbox-claude@latest kimi-init",
});

export function updateNotice(current, latest, surface) {
  const command = UPDATE_COMMANDS[surface] ?? "npx -y @mcpbox/mcpbox-claude@latest";
  return `mcpbox ${current} → ${latest}.\nОбновить: ${command}`;
}
