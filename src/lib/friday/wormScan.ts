// Worm scanner — recognizes the PolinRider "tip-rewrite" worm's footprints in a checkout or a git ref.
//
// Why this exists (2026-09-28 incident): the worm force-pushed copies of real commits carrying an
// obfuscated payload hidden after whitespace in build configs (postcss/tailwind/next.config), a
// "font" that is really JavaScript, a hidden VS Code task that runs it on folder open, and a
// .gitignore that stops ignoring .env and starts ignoring config.bat. FRIDAY's rounds BUILT those
// worktrees (next build loads postcss.config → the payload ran on this box), and her agents "fixed"
// the malware as ordinary code changes without ever telling the owner.
//
// Rules of this module: it only READS. Nothing here executes repository code — the only process it
// starts is `git` (ls-files / grep / ls-tree / cat-file / rev-parse), never npm, node or a shell.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type WormSignature =
  | "payload-marker"        // the payload's own marker strings (see MARKERS)
  | "folder-open-launcher"  // .vscode task with "runOn": "folderOpen"
  | "auto-tasks"            // .vscode settings turning automatic tasks on
  | "fake-font"             // public/fonts/fa-*-400|900.woff2 that isn't a wOF2 binary
  | "config-bat-ignore"     // .gitignore hiding config.bat
  | "config-long-line"      // a build config with a >1000-char line
  | "config-hidden-code"    // a build config with code after 150+ spaces
  | "agent-reported";       // an agent run said "MALWARE SUSPECTED"

export interface WormHit { file: string; signature: WormSignature; detail: string }

/** What an agent must print when it sees any of this (see deliverableGuidance). */
export const MALWARE_MARKER = "MALWARE SUSPECTED";

// Built from pieces so this source never contains the literal markers — the repo's worm-sentinel CI
// greps every tracked file for them and would flag the scanner itself.
const q = "'";
export const MARKERS = [`global[${q}!${q}]=`, `global.i="A9` + "-", "_padNc" + "Ywam"];
const FONT_RX = /(^|\/)public\/fonts\/fa-[a-z0-9]+-(?:400|900)\.woff2$/i;
const CONFIG_RX = /(^|\/)(?:postcss|tailwind|next|vite|eslint)\.config\.(?:js|cjs|mjs|ts|cts|mts)$/i;
const VSCODE_RX = /(^|\/)\.vscode\/(?:tasks|settings)\.json$/i;
const GITIGNORE_RX = /(^|\/)\.gitignore$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const GITHUB_DIR_RX = /^\.github\//;
const SKIP_DIR_RX = /(^|\/)(?:node_modules|\.next|\.git)(\/|$)/;

/** Files whose CONTENT beyond the payload marker matters (the rest only need the marker check). */
export function isStructuralPath(file: string): boolean {
  return FONT_RX.test(file) || CONFIG_RX.test(file) || VSCODE_RX.test(file) || GITIGNORE_RX.test(file);
}

function oneLine(s: string, n = 80): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

/** Every signature one file matches. Pure — tested with fixtures for each signature. */
export function scanFile(file: string, content: Buffer): WormHit[] {
  const f = file.replace(/\\/g, "/");
  const hits: WormHit[] = [];
  const text = content.toString("latin1"); // byte-preserving; the markers are ASCII
  // CI workflows are exempt from the marker check: the repos' own worm-sentinel tripwire must name the
  // markers to look for them (the sentinel excludes .github for the same reason).
  for (const m of GITHUB_DIR_RX.test(f) ? [] : MARKERS) {
    if (text.includes(m)) { hits.push({ file: f, signature: "payload-marker", detail: `contains the worm payload marker ${m}` }); break; }
  }
  if (FONT_RX.test(f) && content.subarray(0, 4).toString("latin1") !== "wOF2") {
    hits.push({ file: f, signature: "fake-font", detail: "named like a font but is not a WOFF2 file (it is text/script)" });
  }
  if (VSCODE_RX.test(f)) {
    if (/"runOn"\s*:\s*"folderOpen"/i.test(text)) hits.push({ file: f, signature: "folder-open-launcher", detail: "a VS Code task that runs automatically when the folder is opened" });
    if (/"task\.allowAutomaticTasks"\s*:\s*(?:true|"on")/i.test(text)) hits.push({ file: f, signature: "auto-tasks", detail: "VS Code settings that let tasks run automatically" });
  }
  if (GITIGNORE_RX.test(f) && text.split(/\r?\n/).some((l) => /^\/?config\.bat$/i.test(l.trim()))) {
    hits.push({ file: f, signature: "config-bat-ignore", detail: ".gitignore hides config.bat (the worm's Windows launcher)" });
  }
  if (CONFIG_RX.test(f)) {
    const lines = text.split(/\r?\n/);
    const long = lines.findIndex((l) => l.length > 1000);
    if (long >= 0) hits.push({ file: f, signature: "config-long-line", detail: `line ${long + 1} is ${lines[long].length} characters long` });
    const hidden = lines.findIndex((l) => /\S[ \t]{150,}\S/.test(l) || /^[ \t]{150,}\S/.test(l));
    if (hidden >= 0) hits.push({ file: f, signature: "config-hidden-code", detail: `line ${hidden + 1} has code hidden after a long run of spaces: ${oneLine(lines[hidden].trimStart(), 40)}…` });
  }
  return hits;
}

/** Scan a set of in-memory entries. Pure. */
export function scanEntries(entries: Iterable<{ path: string; content: Buffer }>): WormHit[] {
  const out: WormHit[] = [];
  for (const e of entries) out.push(...scanFile(e.path, e.content));
  return out;
}

/**
 * Hits from an agent's own output: only the explicit stop-and-report line it was told to print — a
 * line that STARTS with "MALWARE SUSPECTED:" (optionally after list/quote/bold markup). A reply that
 * merely mentions the phrase mid-sentence is not a report. Pure.
 */
export function scanAgentOutput(text: string | undefined | null): WormHit[] {
  if (!text) return [];
  const m = text.match(/^[ \t]*(?:[-*>][ \t]*)?(?:\*\*)?MALWARE SUSPECTED(?:\*\*)?:[^\n]*/m);
  if (!m) return [];
  return [{ file: "(agent report)", signature: "agent-reported", detail: oneLine(m[0].replace(/^[\s*>-]+/, ""), 200) }];
}

/** Plain-English list of what matched, for the owner email. Pure. */
export function describeHits(hits: WormHit[], max = 8): string {
  const lines = hits.slice(0, max).map((h) => `- ${h.file}: ${h.detail}`);
  if (hits.length > max) lines.push(`- …and ${hits.length - max} more`);
  return lines.join("\n");
}

interface GitOut { ok: boolean; code: number | null; out: string; buf: Buffer }
function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
      resolve({ ok: !err, code, out: buf.toString("utf8"), buf });
    });
  });
}

/** Thrown when a scan could not be completed — callers must treat it as "not scanned", never clean. */
export class ScanIncompleteError extends Error {}

/** git repos to scan under a directory: itself when it is one, else its immediate subfolders that are. */
async function gitRootsUnder(dir: string): Promise<string[]> {
  if (await fs.stat(path.join(dir, ".git")).then(() => true, () => false)) return [dir];
  const kids = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const roots: string[] = [];
  for (const k of kids) {
    if (!k.isDirectory()) continue;
    const p = path.join(dir, k.name);
    if (await fs.stat(path.join(p, ".git")).then(() => true, () => false)) roots.push(p);
  }
  return roots;
}

export interface RootScan { root: string; hits: WormHit[] }

/**
 * Scan a working directory (a worktree, a clone, or a folder of clones): every tracked and untracked
 * (non-ignored) file, read from disk. node_modules/.next/.git are skipped; files over 4 MB are skipped.
 */
export async function scanDir(dir: string): Promise<RootScan[]> {
  const out: RootScan[] = [];
  for (const root of await gitRootsUnder(dir)) {
    const ls = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
    if (!ls.ok) throw new ScanIncompleteError(`git ls-files failed in ${root}`);
    const files = [...new Set(ls.out.split("\0").filter((f) => f && !SKIP_DIR_RX.test(f)))];
    const hits: WormHit[] = [];
    for (const f of files) {
      const abs = path.join(root, f);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue; // deleted in the tree / symlink / huge
      hits.push(...scanFile(f, await fs.readFile(abs)));
    }
    out.push({ root, hits });
  }
  return out;
}

/**
 * Scan a git ref (e.g. a fetched PR head or origin/main) without checking it out: `git grep` for the
 * payload markers across every file, plus the structural files read with `git cat-file`.
 */
export async function scanGitRef(repoDir: string, ref: string): Promise<WormHit[]> {
  const hits: WormHit[] = [];
  const grep = await git(["grep", "-z", "-l", "-F", "-I", ...MARKERS.flatMap((m) => ["-e", m]), ref, "--", ".", ":(exclude).github"], repoDir, 120_000);
  // Exit 1 with no output is "no match"; any other failure (bad ref, timeout, buffer) is not a scan.
  if (!grep.ok && !(grep.code === 1 && grep.out === "")) throw new ScanIncompleteError(`git grep failed on ${ref}`);
  const marked = new Set<string>();
  for (const entry of grep.out.split("\0")) {
    if (!entry) continue;
    const file = entry.startsWith(`${ref}:`) ? entry.slice(ref.length + 1) : entry;
    marked.add(file);
    hits.push({ file, signature: "payload-marker", detail: "contains the worm payload marker" });
  }
  const tree = await git(["ls-tree", "-r", "-z", ref], repoDir, 60_000);
  if (!tree.ok) throw new ScanIncompleteError(`git ls-tree failed on ${ref}`);
  for (const entry of tree.out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, sha] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    if (type !== "blob" || !isStructuralPath(file) || SKIP_DIR_RX.test(file)) continue; // submodules etc.
    const blob = await git(["cat-file", "blob", sha], repoDir);
    if (!blob.ok) throw new ScanIncompleteError(`git cat-file failed for ${file}`);
    if (blob.buf.length > MAX_FILE_BYTES) continue;
    // The marker is already reported from `git grep` — keep the structural findings only.
    hits.push(...scanFile(file, blob.buf).filter((h) => !(h.signature === "payload-marker" && marked.has(file))));
  }
  return hits;
}

/** origin URL, branch and HEAD sha of a checkout (for the owner email). Never throws. */
export async function describeCheckout(root: string): Promise<{ remote?: string; branch?: string; sha?: string }> {
  const [r, b, s] = await Promise.all([
    git(["remote", "get-url", "origin"], root),
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    git(["rev-parse", "HEAD"], root),
  ]);
  return { remote: r.ok ? r.out.trim() : undefined, branch: b.ok ? b.out.trim() : undefined, sha: s.ok ? s.out.trim() : undefined };
}
