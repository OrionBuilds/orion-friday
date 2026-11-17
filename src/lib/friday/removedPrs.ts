// PRs the owner took off FRIDAY's hands (2026-11-13): she never lists, checks, rebases, merges or reports
// them, and they drop out of the open-PR view she sends the OS. Owner-edited file
// ~/.agentic-os/friday/pr-removed.json, a JSON array of PR URLs. FRIDAY only reads it.
import path from "node:path";
import { promises as fs } from "node:fs";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";

export const REMOVED_PRS_FILE = () => path.join(FRIDAY_DATA_DIR, "pr-removed.json");

/** "owner/repo/pull/N", lowercased; null when the text isn't a GitHub PR URL. */
export function prKey(url: string): string | null {
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase() : null;
}

let cache: { file: string; mtimeMs: number; keys: Set<string> } | null = null;

/** The removed PRs as keys. A missing or unreadable file means none; re-read only when it changes. */
export async function removedPrKeys(file = REMOVED_PRS_FILE()): Promise<Set<string>> {
  let mtimeMs: number;
  try { mtimeMs = (await fs.stat(file)).mtimeMs; } catch { return new Set(); }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.keys;
  let keys = new Set<string>();
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (Array.isArray(raw)) keys = new Set(raw.map((u) => prKey(String(u))).filter((k): k is string => !!k));
  } catch { /* a bad edit counts as no list rather than stopping the shepherd */ }
  cache = { file, mtimeMs, keys };
  return keys;
}

export async function isRemovedPr(url: string, file?: string): Promise<boolean> {
  const k = prKey(url);
  return !!k && (await removedPrKeys(file)).has(k);
}
