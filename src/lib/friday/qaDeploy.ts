// Post-deploy QA — the verify half of "deploy & verify" (SOP #2; Phase 5 FRIDAY tranche).
//
// WHAT THIS ACTUALLY CHECKS, honestly: HTTP-level verification only. Per URL: status, latency,
// response size, and content assertions; plus one TLS-certificate expiry read per site. It does
// NOT run a browser — this repo deliberately has no playwright/puppeteer (a headless browser is a
// heavy dependency FRIDAY doesn't otherwise carry), so JS console errors, hydration failures and
// client-side rendering breakage are invisible here. The output says so every time rather than
// letting "QA passed" imply more than it tested. If a browser dep ever lands (the plan's
// browser-worker service), console-error capture belongs here.
//
// PER-PROJECT CONFIG. Beyond the default root-page check, extra URLs + content assertions live in
// <FRIDAY_DATA_DIR>/qa-checks.json, keyed by project id (or lowercased project name):
//   { "<projectId>": { "urls": [ { "path": "/pricing", "mustContain": ["Starter", "Pro"] } ] } }
// Missing file / missing key = just the default check. Config is data, not code — adding a check
// never needs a deploy.

import { promises as fs } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { FRIDAY_DATA_DIR } from "@/lib/persistence/store";
import type { Project } from "@/lib/friday/types";

// Everything this module needs from a Project — narrow, so an ad-hoc "just check this URL" call
// can pass a synthesized row without pretending to be a full store record.
export type QaTarget = Pick<Project, "id" | "name" | "deployUrl">;

const QA_CONFIG_FILE = path.join(FRIDAY_DATA_DIR, "qa-checks.json");

interface QaUrlSpec { path: string; mustContain?: string[] }
type QaConfig = Record<string, { urls?: QaUrlSpec[] }>;

interface UrlResult {
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  bytes?: number;
  missing?: string[]; // content assertions that did NOT match
  error?: string;
}

export interface QaReport {
  site: string;
  ok: boolean;
  urls: UrlResult[];
  tls: { ok: boolean; daysLeft?: number; expires?: string; error?: string } | null;
}

async function readQaConfig(): Promise<QaConfig> {
  try { return JSON.parse(await fs.readFile(QA_CONFIG_FILE, "utf8")) as QaConfig; } catch { return {}; }
}

function specsFor(project: QaTarget, cfg: QaConfig): QaUrlSpec[] {
  const entry = cfg[project.id] ?? cfg[project.name.toLowerCase()];
  const extra = entry?.urls ?? [];
  // The root page is always checked; config paths add to it, never replace it.
  return [{ path: "/" }, ...extra.filter((u) => typeof u?.path === "string" && u.path.startsWith("/"))];
}

async function checkUrl(base: URL, spec: QaUrlSpec): Promise<UrlResult> {
  const url = new URL(spec.path, base).toString();
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "FRIDAY-qa-check/1.0 (post-deploy verification)" },
    });
    const body = await res.text();
    const ms = Date.now() - t0;
    const missing = (spec.mustContain ?? []).filter((needle) => !body.includes(needle));
    return { url, ok: res.status < 400 && missing.length === 0, status: res.status, ms, bytes: body.length, missing: missing.length ? missing : undefined };
  } catch (e) {
    return { url, ok: false, ms: Date.now() - t0, error: String(e instanceof Error ? e.message : e).slice(0, 160) };
  }
}

// One TLS handshake against :443 to read the certificate's expiry. Skipped for plain-http sites.
function checkTls(host: string): Promise<QaReport["tls"]> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      if (!validTo || Number.isNaN(validTo.getTime())) return resolve({ ok: false, error: "certificate read but expiry unparsable" });
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      // 21 days is the alarm line: Let's Encrypt renews at 30 days out, so anything under 21 means
      // renewal has already failed at least twice.
      resolve({ ok: daysLeft > 21, daysLeft, expires: validTo.toISOString().slice(0, 10) });
    });
    socket.on("error", (e) => resolve({ ok: false, error: String(e.message ?? e).slice(0, 120) }));
    socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, error: "TLS handshake timed out" }); });
  });
}

/** Run the HTTP-level post-deploy checks for a project's production URL. Read-only. */
export async function qaCheckDeploy(project: QaTarget): Promise<{ ok: boolean; report?: QaReport; error?: string }> {
  const raw = (project.deployUrl ?? "").trim();
  if (!raw) return { ok: false, error: `no production URL on record for "${project.name}" — set deployUrl on the project first.` };
  let base: URL;
  try { base = new URL(raw.startsWith("http") ? raw : `https://${raw}`); } catch { return { ok: false, error: `"${raw}" isn't a usable URL.` }; }

  const specs = specsFor(project, await readQaConfig());
  const urls = await Promise.all(specs.map((spec) => checkUrl(base, spec)));
  const tlsResult = base.protocol === "https:" ? await checkTls(base.hostname) : null;

  const ok = urls.every((u) => u.ok) && (tlsResult === null || tlsResult.ok);
  return { ok, report: { site: base.origin, ok, urls, tls: tlsResult } };
}

export function summarizeQaReport(r: QaReport): string {
  const lines: string[] = [`${r.ok ? "QA PASS" : "QA FAIL"} — ${r.site} (${r.urls.length} URL check(s))`];
  for (const u of r.urls) {
    if (u.error) { lines.push(`· FAIL ${u.url} — ${u.error}`); continue; }
    const assertions = u.missing?.length ? ` — MISSING content: ${u.missing.map((m) => `"${m.slice(0, 40)}"`).join(", ")}` : "";
    lines.push(`· ${u.ok ? "ok" : "FAIL"} ${u.url} [${u.status}] ${u.ms}ms ${u.bytes ?? "?"}B${assertions}`);
  }
  if (r.tls) {
    lines.push(r.tls.ok
      ? `· TLS ok — certificate valid until ${r.tls.expires} (${r.tls.daysLeft} days left)`
      : `· TLS ${r.tls.error ? `FAIL — ${r.tls.error}` : `WARNING — certificate expires ${r.tls.expires} (${r.tls.daysLeft} days left; renewal is overdue)`}`);
  }
  lines.push("HTTP-level checks only — no headless browser in this repo, so JS console errors and client-side rendering breakage are not covered.");
  return lines.join("\n");
}
