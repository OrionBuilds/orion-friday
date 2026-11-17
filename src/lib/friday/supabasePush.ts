// FRIDAY — automatic Supabase migration push after a merged PR.
//
// Problem it closes (Initech Box, 2026-10-02): FRIDAY's PR shipped the migration file correctly,
// The owner merged it, Netlify rebuilt the UI — and the hosted Supabase project never saw the
// migration. The UI called a function that didn't exist in the schema cache, and the client got
// a page of PL/pgSQL error message when they tried to use the new feature.
//
// How we do the push (2026-10-02 revision — owner rule "she must access every project"):
//
//   NOT the Supabase CLI. The CLI needs a per-project DB password, which means a one-time setup
//   per client project before FRIDAY can push to it — the exact "she can't do it autonomously"
//   gap we're closing.
//
//   Instead: Supabase Management API. `SUPABASE_ACCESS_TOKEN` from FRIDAY's env covers every
//   project in the owner's Supabase account by itself (it's a user-level personal access token). The
//   `/v1/projects/{ref}/database/query` endpoint runs arbitrary SQL against the project's
//   database with just that bearer token — no per-project password, no per-project setup.
//
//   For each unapplied migration we:
//     1. Wrap the migration body in BEGIN / COMMIT so a partial failure never leaves the
//        schema_migrations ledger out of sync with the actual tables.
//     2. INSERT INTO supabase_migrations.schema_migrations(version, name) inside the same
//        transaction so a successful migration is recorded atomically with its effects.
//     3. ON CONFLICT (version) DO NOTHING on the ledger insert — a re-run of the same merge sha
//        is a no-op even if some manual push already recorded the version.
//
// Scope rules:
//   - Only runs for FRIDAY-owned merges (landMerged is the single call site).
//   - Only runs when the merge actually touched `supabase/migrations/*.sql` (checked via GitHub's
//     files endpoint — no clone wasted when nothing changed).
//   - Each failure mode texts the owner distinctly: no ref on project_agent_meta, no token in env,
//     or a push that errored (with the Postgres error truncated to 400 chars).
//
// Kill switch: FRIDAY_SUPABASE_AUTOPUSH=off reverts to the pre-2026-10-02 "The owner runs it" flow.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const MGMT_BASE = "https://api.supabase.com/v1";

/** Env gate — default on. "off" disables the whole autopush pipeline. */
export function autopushEnabled(): boolean {
  return (process.env.FRIDAY_SUPABASE_AUTOPUSH ?? "on").trim().toLowerCase() !== "off";
}

/** Access token — a user-level PAT from supabase.com/dashboard/account/tokens covers every project. */
export function supabaseAccessToken(): string | null {
  const t = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  return t ? t : null;
}

/** Which of the merge's changed files are supabase migrations. Repo-root OR nested apps/pkg. */
export function changedMigrations(files: readonly string[]): string[] {
  return files.filter((f) => /(^|\/)supabase\/migrations\/[^/]+\.sql$/i.test(f));
}

/** Parse `20260925120000_add_contact_overrides.sql` → { version, name }. Returns null on mismatch. */
export function parseMigrationFilename(filename: string): { version: string; name: string } | null {
  const base = path.basename(filename);
  const m = base.match(/^(\d{14})_(.+)\.sql$/i);
  return m ? { version: m[1], name: m[2] } : null;
}

export interface LocalMigration { version: string; name: string; path: string; sql: string; }

/** Read every `supabase/migrations/*.sql` in a repo clone, parse the filename, sort by version. */
export async function readLocalMigrations(repoRoot: string): Promise<LocalMigration[]> {
  const dir = path.join(repoRoot, "supabase", "migrations");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const out: LocalMigration[] = [];
  for (const f of entries) {
    const parsed = parseMigrationFilename(f);
    if (!parsed) continue;
    const abs = path.join(dir, f);
    const sqlText = await fs.readFile(abs, "utf8").catch(() => null);
    if (sqlText == null) continue;
    out.push({ ...parsed, path: abs, sql: sqlText });
  }
  out.sort((a, b) => a.version.localeCompare(b.version));
  return out;
}

interface RunResult { ok: boolean; stdout: string; stderr: string; code: number | null; }

async function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { stderr += "\n[timeout]"; child.kill("SIGKILL"); }, opts.timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: `${stderr}\n${String(e)}`, code: null }); });
  });
}

interface SqlResult { ok: boolean; rows: unknown[]; error?: string; status?: number; }

/** POST /v1/projects/<ref>/database/query — single SQL body, bearer-token auth, no DB password. */
export async function execSql(projectRef: string, query: string, token: string, timeoutMs = 60_000): Promise<SqlResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${MGMT_BASE}/projects/${projectRef}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    });
    const bodyText = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, rows: [], error: lastChars(bodyText || r.statusText, 400), status: r.status };
    let rows: unknown[] = [];
    try {
      const parsed = JSON.parse(bodyText);
      if (Array.isArray(parsed)) rows = parsed;
    } catch { /* empty / non-JSON (DDL): fine */ }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, rows: [], error: String((e as Error).message ?? e).slice(0, 400) };
  } finally {
    clearTimeout(t);
  }
}

/** Ensure `supabase_migrations.schema_migrations` exists (idempotent), then return applied versions. */
export async function appliedVersions(projectRef: string, token: string): Promise<Set<string>> {
  const ensure = `
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      name text,
      statements text[],
      inserted_at timestamptz default now()
    );
  `;
  await execSql(projectRef, ensure, token);
  const r = await execSql(projectRef, `select version from supabase_migrations.schema_migrations`, token);
  if (!r.ok) return new Set();
  const out = new Set<string>();
  for (const row of r.rows) {
    const v = (row as { version?: unknown })?.version;
    if (typeof v === "string") out.add(v);
  }
  return out;
}

/**
 * Build the exact SQL body for one migration: wrap it in a transaction with its ledger insert so
 * the version is only recorded when the migration itself commits. Keeps `on conflict do nothing`
 * so a redelivered push after a prior success is a no-op. SQL-safe: `version` is 14 digits by
 * construction and `name` only has filename-safe characters; both are quoted and single-quote-
 * escaped as a belt + suspenders. The migration body is pasted untouched.
 */
export function wrapMigration(mig: Pick<LocalMigration, "version" | "name" | "sql">): string {
  const esc = (s: string): string => s.replace(/'/g, "''");
  return [
    "begin;",
    mig.sql,
    `insert into supabase_migrations.schema_migrations(version, name) values ('${esc(mig.version)}', '${esc(mig.name)}') on conflict (version) do nothing;`,
    "commit;",
    "",
  ].join("\n");
}

export interface PushInput {
  repoUrl: string;     // https://github.com/<owner>/<repo>
  mergeSha: string;    // the merge commit on the default branch
  projectRef: string;  // Supabase project ref
  token: string;       // Supabase personal access token (from env; covers every project)
  perMigrationTimeoutMs?: number; // default 120_000 — any one migration is given this long
}

export interface PushResult {
  ok: boolean;
  summary: string;
  applied: string[];
}

/**
 * Clone the merge sha into a temp dir, read supabase/migrations/*.sql, apply each one that the
 * project hasn't recorded. Idempotent: re-running the same merge is a no-op.
 */
export async function pushMigrations(input: PushInput): Promise<PushResult> {
  const perMig = input.perMigrationTimeoutMs ?? 120_000;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "friday-supabase-"));
  const applied: string[] = [];
  try {
    const clone = await run("git", ["clone", "--filter=blob:none", input.repoUrl, tmp], { cwd: os.tmpdir(), timeoutMs: 90_000 });
    if (!clone.ok) return { ok: false, summary: `git clone failed: ${lastChars(clone.stderr, 240)}`, applied };
    const co = await run("git", ["checkout", input.mergeSha], { cwd: tmp, timeoutMs: 30_000 });
    if (!co.ok) {
      const fetched = await run("git", ["fetch", "origin", input.mergeSha], { cwd: tmp, timeoutMs: 60_000 });
      if (!fetched.ok) return { ok: false, summary: `git fetch ${input.mergeSha.slice(0, 7)} failed: ${lastChars(fetched.stderr, 240)}`, applied };
      const co2 = await run("git", ["checkout", input.mergeSha], { cwd: tmp, timeoutMs: 30_000 });
      if (!co2.ok) return { ok: false, summary: `git checkout failed: ${lastChars(co2.stderr, 240)}`, applied };
    }
    const local = await readLocalMigrations(tmp);
    if (local.length === 0) return { ok: true, summary: "no migrations found in repo", applied };
    const already = await appliedVersions(input.projectRef, input.token);
    for (const mig of local) {
      if (already.has(mig.version)) continue;
      const body = wrapMigration(mig);
      const res = await execSql(input.projectRef, body, input.token, perMig);
      if (!res.ok) {
        return {
          ok: false,
          summary: `migration ${mig.version} (${mig.name}) failed: ${res.error ?? "unknown error"}`,
          applied,
        };
      }
      applied.push(mig.version);
    }
    return {
      ok: true,
      summary: applied.length ? `applied ${applied.length}: ${applied.join(", ")}` : "nothing new to apply",
      applied,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Last `max` chars of a (possibly multi-line) string, trimmed trailing whitespace. Pure. */
export function lastChars(s: string, max: number): string {
  const t = s.replace(/\s+$/g, "");
  return t.length <= max ? t : t.slice(-max);
}
