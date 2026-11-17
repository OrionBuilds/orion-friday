// GitHub owner as configuration (2026-10-28 audit gap 5; contract §7).
//
// When repos move between GitHub owners, PR discovery breaks if the owner is hardcoded
// (`gh search prs --owner <old>` → "cannot be searched"), and FRIDAY is a public template, so no
// owner may be baked into code paths. Resolution order:
//   1. GITHUB_OWNER
//   2. the owner of this checkout's own `origin` remote (cached; server-side only)
// Legacy owners (FRIDAY_GITHUB_LEGACY_OWNERS, default none) are rewritten to the current
// owner IN MEMORY wherever a repo URL or owner/repo key is read, so a stale stored URL keeps working.
//
// Deliberately free of static node imports: types.ts (projectRepos) imports this module and is
// itself pulled into client components. The remote lookup uses process.getBuiltinModule, which
// does not exist in a browser bundle — there it is simply skipped.

let detected: string | null | undefined; // undefined = not tried yet

function detectRemoteOwner(): string | null {
  if (detected !== undefined) return detected;
  detected = null;
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin !== "function") return null;
    const cp = getBuiltin("node:child_process") as typeof import("node:child_process") | undefined;
    if (!cp?.execFileSync) return null;
    const url = String(cp.execFileSync("git", ["remote", "get-url", "origin"], { cwd: process.cwd(), timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    const m = url.match(/github\.com[/:]([^/\s]+)\//i);
    detected = m ? m[1] : null;
  } catch {
    detected = null;
  }
  return detected;
}

/** Owner names treated as moved-away aliases of the current owner (lower-cased). */
export function legacyGithubOwners(env: string | undefined = process.env.FRIDAY_GITHUB_LEGACY_OWNERS): string[] {
  const raw = (env ?? "").trim();
  const list = raw ? raw.split(/[\s,]+/).filter((x) => /^[\w.-]+$/.test(x)) : [];
  return [...new Set(list.map((x) => x.toLowerCase()))];
}

/** The GitHub owner FRIDAY works under: GITHUB_OWNER, else the origin remote's owner. Null when neither is known. */
export function githubOwner(env: string | undefined = process.env.GITHUB_OWNER): string | null {
  const v = (env ?? "").trim();
  if (/^[\w.-]+$/.test(v)) return v;
  return detectRemoteOwner();
}

function currentOwnerFor(owner: string, current: string | null, legacy: string[]): string {
  if (!current) return owner;
  return legacy.includes(owner.toLowerCase()) && owner.toLowerCase() !== current.toLowerCase() ? current : owner;
}

/** Rewrite a GitHub URL whose owner is a legacy alias to the current owner. Anything else passes through. */
export function normalizeGithubUrl(
  url: string,
  current: string | null = githubOwner(),
  legacy: string[] = legacyGithubOwners(),
): string {
  if (!url || !current) return url;
  return url.replace(/^(\s*(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:))([^/\s]+)(\/)/i,
    (_m, pre: string, owner: string, slash: string) => `${pre}${currentOwnerFor(owner, current, legacy)}${slash}`);
}

/** Same rewrite for an `owner/repo` key. */
export function normalizeRepoKey(
  key: string,
  current: string | null = githubOwner(),
  legacy: string[] = legacyGithubOwners(),
): string {
  const m = key.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m || !current) return key;
  return `${currentOwnerFor(m[1], current, legacy)}/${m[2]}`;
}

/** Test hook. */
export function _resetGithubOwnerCache(value?: string | null): void {
  detected = value;
}
