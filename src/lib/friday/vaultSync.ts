// Mirror the FRIDAY + CLARA Obsidian vaults (on this box) to the Orion /memory module.
//
// Protocol (Orion supabase/functions/vault-sync): per vault, POST
//   manifest { vault, entries: [{ path, hash }] }  → { need: [paths], removed }   (server drops vanished notes)
//   upsert   { vault, notes: [...] }               → notes + outgoing [[wikilinks]] (≤100 notes, ≤2 MB per call)
//   finish   { vault, error? }                     → counts + last sync for the OS header
// Auth is a dedicated sync key (X-Vault-Sync-Key), not an agent sign-in: VAULT_SYNC_KEY, else the file
// ~/.agentic-os/vault-sync.key. The OS compares it with its VAULT_SYNC_KEY secret; it can only call vault-sync.
// Wikilinks resolve exactly like vaultGraph.ts / Obsidian: by note title, case-insensitive, first wins.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type VaultName = "friday" | "clara";
/** Only a few keys are read, so tests can pass a plain map (NodeJS.ProcessEnv requires NODE_ENV). */
export type Env = Record<string, string | undefined>;
export interface VaultSource { vault: VaultName; root: string }

export const MAX_NOTE_BYTES = 512 * 1024;   // matches the OS edge function's per-note cap
export const MAX_NOTES_PER_BATCH = 100;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_DEPTH = 8;

const WIKILINK_RE = /\[\[([^[\]\n|#]+)(?:#[^[\]\n|]+)?(?:\|[^[\]\n]+)?\]\]/g;

/** Obsidian config, trash, git and other dot-dirs, plus node_modules, are never notes. */
export function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

export function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function titleOf(rel: string): string {
  return rel.split("/").pop()!.replace(/\.md$/i, "");
}

/** Top-level folder (the PARA bucket the views colour by); notes at the vault root → "root". */
export function folderOf(rel: string): string {
  const i = rel.indexOf("/");
  return i === -1 ? "root" : rel.slice(0, i);
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** title (lower-case) → path, first-wins in sorted order so collisions resolve deterministically. */
export function buildTitleIndex(relPaths: string[]): Map<string, string> {
  const byTitle = new Map<string, string>();
  for (const rel of [...relPaths].sort()) {
    const key = titleOf(rel).toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, rel);
  }
  return byTitle;
}

/** Outgoing links of a note as target paths: [[Title]], [[Title|alias]], [[Title#h]], [[Folder/Title]]. */
export function resolveLinks(content: string, byTitle: Map<string, string>, allPaths: Set<string>, selfRel: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    const asPath = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
    const rel = allPaths.has(asPath) ? asPath : byTitle.get(titleOf(target).toLowerCase());
    if (rel && rel !== selfRel) out.add(rel);
  }
  return [...out];
}

/** Split into batches of ≤ maxCount items and ≤ maxBytes of content each (a lone oversize item still ships). */
export function batchNotes<T extends { content: string }>(items: T[], maxCount = MAX_NOTES_PER_BATCH, maxBytes = MAX_BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const b = Buffer.byteLength(it.content, "utf8");
    if (cur.length && (cur.length >= maxCount || bytes + b > maxBytes)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(it);
    bytes += b;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export interface VaultFile { rel: string; abs: string; size: number; mtimeMs: number }

/** Every .md note under root (depth-limited), skipping dot-dirs and oversize files. */
export async function walkVault(root: string, maxDepth = MAX_DEPTH): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!shouldSkipDir(it.name)) await walk(full, depth + 1);
      } else if (it.isFile() && /\.md$/i.test(it.name)) {
        const s = await stat(full).catch(() => null);
        if (s && s.size <= MAX_NOTE_BYTES) out.push({ rel: toRelPosix(root, full), abs: full, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Hash cache: unchanged files (same mtime + size) are not re-read every run.
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

async function hashOf(f: VaultFile): Promise<string> {
  const hit = hashCache.get(f.abs);
  if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.hash;
  const hash = sha256(await readFile(f.abs, "utf8"));
  hashCache.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, hash });
  return hash;
}

export type Post = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface VaultSyncResult { vault: VaultName; total: number; uploaded: number; removed: number }

export async function syncVault(src: VaultSource, post: Post): Promise<VaultSyncResult> {
  try {
    const files = await walkVault(src.root);
    const entries = await Promise.all(files.map(async (f) => ({ path: f.rel, hash: await hashOf(f) })));
    const manifest = await post({ action: "manifest", vault: src.vault, entries });
    const need = new Set(Array.isArray(manifest.need) ? (manifest.need as string[]) : []);

    const byRel = new Map(files.map((f) => [f.rel, f]));
    const allPaths = new Set(byRel.keys());
    const byTitle = buildTitleIndex([...allPaths]);
    const notes = [];
    for (const rel of need) {
      const f = byRel.get(rel);
      if (!f) continue;
      const content = await readFile(f.abs, "utf8");
      notes.push({
        path: rel, title: titleOf(rel), folder: folderOf(rel), content, hash: sha256(content),
        mtime: new Date(f.mtimeMs).toISOString(), links: resolveLinks(content, byTitle, allPaths, rel),
      });
    }
    for (const batch of batchNotes(notes)) await post({ action: "upsert", vault: src.vault, notes: batch });
    await post({ action: "finish", vault: src.vault });
    return { vault: src.vault, total: files.length, uploaded: notes.length, removed: Number(manifest.removed ?? 0) };
  } catch (e) {
    await post({ action: "finish", vault: src.vault, error: (e as Error).message.slice(0, 400) }).catch(() => {});
    throw e;
  }
}

/** FRIDAY's vault (config.vaultRoot) and CLARA's (CLARA_VAULT_ROOT, else ~/.agentic-os/clara.config.json). */
export async function vaultSources(env: Env = process.env): Promise<VaultSource[]> {
  const out: VaultSource[] = [];
  const { VAULT_ROOT } = await import("@/lib/vault");
  if (VAULT_ROOT && existsSync(VAULT_ROOT)) out.push({ vault: "friday", root: VAULT_ROOT });
  let claraRoot = (env.CLARA_VAULT_ROOT ?? "").trim();
  if (!claraRoot) {
    const cfgFile = env.CLARA_CONFIG ?? path.join(os.homedir(), ".agentic-os", "clara.config.json");
    try { claraRoot = String((JSON.parse(readFileSync(cfgFile, "utf8")) as { vaultRoot?: string }).vaultRoot ?? ""); } catch { /* no CLARA config */ }
  }
  if (claraRoot && existsSync(claraRoot)) out.push({ vault: "clara", root: claraRoot });
  return out;
}

const OFF = new Set(["0", "off", "false", "no"]);

/** Matches the OS: a key shorter than this is rejected there, so treat it as missing here. */
export const MIN_SYNC_KEY_LENGTH = 32;
export const SYNC_KEY_FILE = path.join(os.homedir(), ".agentic-os", "vault-sync.key");

/** The sync key: VAULT_SYNC_KEY, else the key file. Null when missing or too short. */
export function syncKey(env: Env = process.env, keyFile = SYNC_KEY_FILE): string | null {
  let key = (env.VAULT_SYNC_KEY ?? "").trim();
  if (!key) {
    try { key = readFileSync(keyFile, "utf8").trim(); } catch { /* no key file */ }
  }
  return key.length >= MIN_SYNC_KEY_LENGTH ? key : null;
}

/** Scheduler entry point. Throws (so the scheduler backs off) when any vault fails. */
export async function runVaultSync(env: Env = process.env, keyFile = SYNC_KEY_FILE): Promise<string> {
  if (OFF.has((env.FRIDAY_VAULT_SYNC ?? "").trim().toLowerCase())) return "vault-sync off";
  const key = syncKey(env, keyFile);
  if (!key) return `vault-sync: no sync key (set VAULT_SYNC_KEY or ${keyFile})`;
  const sources = await vaultSources(env);
  if (!sources.length) return "vault-sync: no vault roots found";

  // The OS project URL is config (no hardcoded Supabase ref — public-template rule, 2026-10-28 audit).
  const base = (env.ORION_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return "vault-sync: ORION_SUPABASE_URL not set";
  const post: Post = async (body) => {
    const r = await fetch(`${base}/functions/v1/vault-sync`, {
      method: "POST",
      headers: { "X-Vault-Sync-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`vault-sync ${body.action}: HTTP ${r.status} ${String(j.error ?? "").slice(0, 200)}`);
    return j;
  };

  const parts: string[] = [];
  let failed = 0;
  for (const src of sources) {
    try {
      const r = await syncVault(src, post);
      parts.push(`${r.vault} ${r.total} notes (${r.uploaded} up, ${r.removed} removed)`);
    } catch (e) {
      failed++;
      parts.push(`${src.vault} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  const summary = `vault-sync: ${parts.join("; ")}`;
  if (failed) throw new Error(summary);
  return summary;
}
