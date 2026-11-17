// Operational log reads — the data behind tail_logs and error_rate (Phase 5 FRIDAY tranche).
//
// PATH JAIL, BY CONSTRUCTION. There is no path argument anywhere in this file's public surface:
// callers name a log from NAMED_LOGS and get that file or nothing. The registry covers exactly the
// files FRIDAY's runtime already owns — the supervisor/watchdog logs a process supervisor writes under
// <repo>/logs, and the JSONL streams the persistence layer appends under FRIDAY_DATA_DIR. Adding a
// log means adding a registry row, deliberately — never interpolating a caller string into a path.
//
// HONESTY ABOUT SCOPE. These are FRIDAY's OWN logs — her orchestration events, her tool telemetry,
// her process supervisor. "Error rate" here means "how often FRIDAY's own machinery failed", not
// "are the client sites erroring" (that's site_health/read_deploys territory). Every summary line
// names its source so the answer can't be mistaken for something it isn't.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";

// A supervisor script may write logs to its own folder; the app itself runs with cwd at the repo root,
// so <cwd>\logs is the same directory without a second hardcode to drift.
const REPO_LOG_DIR = path.join(process.cwd(), "logs");

export interface NamedLog {
  file: string;
  /** Shown in listings and in the "no such log" error, so the model can self-correct. */
  what: string;
  /** JSONL streams get per-line formatting; plain logs are shown as-is. */
  format: "plain" | "orchestration" | "telemetry";
}

export const NAMED_LOGS: Record<string, NamedLog> = {
  app: { file: path.join(REPO_LOG_DIR, "friday-app.log"), what: "the app's stdout/stderr (next start)", format: "plain" },
  service: { file: path.join(REPO_LOG_DIR, "friday-service.log"), what: "the supervisor loop (start/crash/relaunch decisions)", format: "plain" },
  watchdog: { file: path.join(REPO_LOG_DIR, "friday-watchdog.log"), what: "the watchdog's health checks", format: "plain" },
  backup: { file: path.join(REPO_LOG_DIR, "friday-backup.log"), what: "the nightly backup job", format: "plain" },
  orchestration: { file: path.join(FRIDAY_DATA_DIR, "logs.jsonl"), what: "FRIDAY's own event log (every run, approval, failure)", format: "orchestration" },
  telemetry: { file: path.join(FRIDAY_DATA_DIR, "tool-telemetry.jsonl"), what: "per-tool call/success/latency records", format: "telemetry" },
};

export function logNames(): string {
  return Object.entries(NAMED_LOGS).map(([k, v]) => `${k} (${v.what})`).join(", ");
}

// Read the last `maxBytes` of a file without loading the whole thing — friday-app.log has no
// rotation cap and the JSONL streams grow for months.
async function readTailBytes(file: string, maxBytes: number): Promise<string | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, "r");
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Drop the first, likely-partial line when we started mid-file.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// ── tail_logs ─────────────────────────────────────────────────────────────────────────────────────

interface OrchestrationRow { ts?: string; level?: string; event?: string; runId?: string; data?: Record<string, unknown> }
interface TelemetryRow { ts?: string; tool?: string; ok?: boolean; latencyMs?: number; error?: string; source?: string }

function formatLine(raw: string, format: NamedLog["format"]): string {
  if (format === "plain") return raw;
  try {
    if (format === "orchestration") {
      const r = JSON.parse(raw) as OrchestrationRow;
      const data = r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data).slice(0, 140)}` : "";
      return `${(r.ts ?? "?").slice(0, 19)} [${r.level ?? "info"}] ${r.event ?? "?"}${data}`;
    }
    const r = JSON.parse(raw) as TelemetryRow;
    return `${(r.ts ?? "?").slice(0, 19)} ${r.tool ?? "?"} ${r.ok ? "ok" : "FAIL"} ${r.latencyMs ?? "?"}ms${r.error ? ` — ${r.error.slice(0, 100)}` : ""}`;
  } catch {
    return raw; // a malformed line is still evidence — show it rather than hide it
  }
}

/** Tail the last `lines` lines of a named log. Read-only; unknown names list what exists. */
export async function tailLog(name: string, lines: number): Promise<{ ok: boolean; text: string }> {
  const log = NAMED_LOGS[name.trim().toLowerCase()];
  if (!log) return { ok: false, text: `no log named "${name}". Known logs: ${logNames()}.` };
  const n = Math.min(Math.max(Math.floor(lines) || 40, 1), 200);
  const tail = await readTailBytes(log.file, 512 * 1024);
  if (tail === null) return { ok: false, text: `${name}: ${log.file} isn't readable (missing, or never written on this box).` };
  const rows = tail.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-n);
  if (!rows.length) return { ok: true, text: `${name}: the log exists but is empty.` };
  const body = rows.map((l) => formatLine(l, log.format)).join("\n");
  return { ok: true, text: `${name} — last ${rows.length} line(s) of ${log.file}:\n${body}`.slice(0, 6000) };
}

// ── error_rate ────────────────────────────────────────────────────────────────────────────────────

export interface ErrorRateReport {
  windowHours: number;
  events: { total: number; warn: number; error: number; topErrors: Array<{ event: string; count: number }> } | null;
  tools: { calls: number; failures: number; worst: Array<{ tool: string; calls: number; failures: number }> } | null;
}

async function jsonlRowsSince<T extends { ts?: string }>(file: string, cutoffISO: string): Promise<T[] | null> {
  // 8 MB of tail covers weeks of either stream; anything older than the window is filtered anyway.
  const tail = await readTailBytes(file, 8 * 1024 * 1024);
  if (tail === null) return null;
  const out: T[] = [];
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as T;
      if (typeof row.ts === "string" && row.ts >= cutoffISO) out.push(row);
    } catch { /* skip malformed lines — counting them as errors would be inventing data */ }
  }
  return out;
}

/** Error counts/rates over the window, from FRIDAY's own event log + tool telemetry. */
export async function errorRate(windowHours: number): Promise<ErrorRateReport> {
  const hours = Math.min(Math.max(windowHours || 24, 1), 24 * 14);
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  const report: ErrorRateReport = { windowHours: hours, events: null, tools: null };

  const events = await jsonlRowsSince<OrchestrationRow>(NAMED_LOGS.orchestration.file, cutoff);
  if (events) {
    const errRows = events.filter((r) => r.level === "error");
    const byEvent = new Map<string, number>();
    for (const r of errRows) byEvent.set(r.event ?? "?", (byEvent.get(r.event ?? "?") ?? 0) + 1);
    report.events = {
      total: events.length,
      warn: events.filter((r) => r.level === "warn").length,
      error: errRows.length,
      topErrors: [...byEvent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([event, count]) => ({ event, count })),
    };
  }

  const calls = await jsonlRowsSince<TelemetryRow>(NAMED_LOGS.telemetry.file, cutoff);
  if (calls) {
    const byTool = new Map<string, { calls: number; failures: number }>();
    for (const r of calls) {
      const row = byTool.get(r.tool ?? "?") ?? { calls: 0, failures: 0 };
      row.calls++;
      if (r.ok === false) row.failures++;
      byTool.set(r.tool ?? "?", row);
    }
    report.tools = {
      calls: calls.length,
      failures: calls.filter((r) => r.ok === false).length,
      worst: [...byTool.entries()]
        .filter(([, v]) => v.failures > 0)
        .sort((a, b) => b[1].failures - a[1].failures)
        .slice(0, 3)
        .map(([tool, v]) => ({ tool, ...v })),
    };
  }

  return report;
}

const pct = (num: number, den: number) => (den ? `${((num / den) * 100).toFixed(1)}%` : "n/a");

export function summarizeErrorRate(r: ErrorRateReport): string {
  const lines: string[] = [`Error rate, last ${r.windowHours}h — source: FRIDAY's own logs, not client sites.`];
  if (r.events) {
    lines.push(`· Orchestration events: ${r.events.total} total, ${r.events.error} error (${pct(r.events.error, r.events.total)}), ${r.events.warn} warn.`);
    if (r.events.topErrors.length) lines.push(...r.events.topErrors.map((e) => `  – ${e.event} ×${e.count}`));
  } else {
    lines.push("· Orchestration event log unreadable — no event numbers.");
  }
  if (r.tools) {
    lines.push(`· Tool calls: ${r.tools.calls} total, ${r.tools.failures} failed (${pct(r.tools.failures, r.tools.calls)}).`);
    if (r.tools.worst.length) lines.push(...r.tools.worst.map((t) => `  – ${t.tool}: ${t.failures}/${t.calls} failed`));
  } else {
    lines.push("· Tool telemetry unreadable — no per-tool numbers.");
  }
  if (r.events && !r.events.total && r.tools && !r.tools.calls) lines.push("Nothing at all in the window — quiet, or the window predates the logs.");
  return lines.join("\n");
}
