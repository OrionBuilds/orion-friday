// Bench separation + soul sanitizing (one library, two manifests).
//
// FRIDAY (dev/COO) and a marketing agent (CMO) index the SAME on-disk library. A single shared
// allocation manifest (library-manifest.json) classifies every item into dev | marketing | shared;
// each app declares its own `bench` (config.bench, default "dev" here) and may only reach items whose
// bench is its own or "shared". This is the guardrail that keeps a marketing skill from being reachable
// inside FRIDAY (which would route around the marketing agent's compliance layer) and vice-versa.
//
// The same file also sanitizes injected bodies: interpolates ${OWNER}/${AGENCY}/${STACK} placeholders
// and scrubs a small set of other-business literals that rode in on shared "soul" bodies (white-label
// language, a rival 50-agent fleet, a specific example keyword, etc.).

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { OWNER, AGENCY, STACK } from "@/lib/friday/persona";

export type Bench = "dev" | "marketing" | "shared";

interface ScrubRule { pattern: string; replace: string }
interface Manifest {
  default?: Bench;
  sourceDefaults?: Record<string, Bench>;
  marketingKeywords?: string[];
  devKeywords?: string[];
  overrides?: Record<string, Bench>;
  denylist?: string[];
  scrub?: ScrubRule[];
}

// This app's bench. FRIDAY is the dev/COO orchestrator.
const OWN_BENCH: Bench = ((config as unknown as { bench?: string }).bench as Bench) || "dev";

// Minimal safe fallback if the shared manifest is missing — nothing marketing leaks into FRIDAY by
// accident (marketing sources still resolve to "marketing" and are thus excluded here); everything else
// falls to "shared" so availability is preserved.
const FALLBACK: Manifest = {
  default: "shared",
  sourceDefaults: {
    "claude-commands": "dev", "multica-skills": "shared", "orion-prompts": "shared",
    "marketing-skills": "marketing", "vault-sops": "marketing", "marketing-souls": "marketing",
  },
  marketingKeywords: [], devKeywords: [], overrides: {}, denylist: [], scrub: [],
};

function manifestPath(): string {
  const fromCfg = (config as unknown as { libraryManifestPath?: string }).libraryManifestPath;
  return fromCfg || path.join(os.homedir(), "agency-library", "library-manifest.json");
}

let _cache: { m: Manifest; scrub: Array<{ re: RegExp; replace: string }>; loggedDefault: Set<string> } | null = null;
function manifest() {
  if (_cache) return _cache;
  let m: Manifest = FALLBACK;
  const p = manifestPath();
  if (existsSync(p)) {
    try { m = { ...FALLBACK, ...JSON.parse(readFileSync(p, "utf8")) }; }
    catch { m = FALLBACK; }
  }
  const scrub = (m.scrub ?? []).map((s) => ({ re: new RegExp(s.pattern, "gi"), replace: s.replace }));
  _cache = { m, scrub, loggedDefault: new Set() };
  return _cache;
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unnamed";
}

interface Classifiable { name?: string; sourceId?: string; id?: string }

/** The slug used for matching — prefers the name, falls back to the id's last segment. */
function itemSlug(rec: Classifiable): string {
  if (rec.name) return slug(rec.name);
  const tail = (rec.id ?? "").split(":").pop() ?? "";
  return slug(tail);
}

export function isDenied(rec: Classifiable): boolean {
  const { m } = manifest();
  const s = itemSlug(rec);
  return (m.denylist ?? []).some((d) => s === slug(d) || s.includes(slug(d)));
}

/** Classify one library item into a bench. Order: override -> marketing kw -> dev kw -> source default -> default. */
export function benchOf(rec: Classifiable): Bench {
  const { m, loggedDefault } = manifest();
  const s = itemSlug(rec);
  const ov = m.overrides?.[s];
  if (ov) return ov;
  if ((m.marketingKeywords ?? []).some((k) => s.includes(k))) return "marketing";
  if ((m.devKeywords ?? []).some((k) => s.includes(k))) return "dev";
  const sd = rec.sourceId ? m.sourceDefaults?.[rec.sourceId] : undefined;
  if (sd) return sd;
  // Fell through to the global default — record it once so the allocation table can be completed.
  if (!loggedDefault.has(s)) { loggedDefault.add(s); }
  return m.default ?? "shared";
}

/** True if this app's bench may reach the item (own bench or shared, and not denylisted). */
export function allowedForBench(rec: Classifiable): boolean {
  if (isDenied(rec)) return false;
  const b = benchOf(rec);
  return b === OWN_BENCH || b === "shared";
}

// ── Body sanitize (template interpolation + scrub) ─────────────────────────
const TOKENS: Array<[RegExp, string]> = [
  [/\$\{?OWNER\}?|\{OWNER\}/g, OWNER],
  [/\$\{?AGENCY\}?|\{AGENCY\}/g, AGENCY],
  [/\$\{?STACK\}?|\{STACK\}/g, STACK],
];

/** Interpolate ${OWNER}/${AGENCY}/${STACK} placeholders and scrub other-business literals from a body. */
export function sanitizeBody(body: string): string {
  if (!body) return body;
  let out = body;
  for (const [re, val] of TOKENS) out = out.replace(re, val);
  for (const { re, replace } of manifest().scrub) out = out.replace(re, replace);
  return out;
}

/** Items that fell through to the global default (unclassified) — surfaced for completing the table. */
export function unclassifiedSlugs(): string[] {
  return [...manifest().loggedDefault];
}
