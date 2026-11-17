// Prospect lookups for CLARA's research engine (plan 2026-09-30, PR 4b).
//
// Agent-Reach — the owner's real LinkedIn session plus Exa search and Jina page reads, behind the
// `reach-guard` command — is pinned to FRIDAY's `research-qa` role and nobody else (owner decision
// 2026-09-20, restated 2026-09-30). CLARA's engine needs an owner-lookup step that returns typed
// fields with provenance, not a paragraph, and must never mint a task or a run. So these two
// handlers are DETERMINISTIC code: no model, no planner, a fixed sequence of guarded calls with the
// guard's own caps, hours, locks and audit trail doing the policing. They run under
// `REACH_AGENT=friday:research-qa` so the audit log attributes every call to the pinned role.
//
// Read-only by construction. Nothing here can post, connect, message, or return an email or a
// phone number (LinkedIn's tools expose none; scraping them would be out of bounds anyway).
//
// LinkedIn's search/profile tools return raw page TEXT ("the LLM should parse the raw text").
// The parsers below are URL-anchored and tolerant — every `linkedin.com/company/<slug>` or
// `/in/<user>` occurrence becomes a candidate with the nearest lines as name/title — and the raw
// excerpts travel back to CLARA so her own model can re-read them. Fetched content is untrusted.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProspectLinkedinLookupInput, ProspectLinkedinLookupResult, ProspectLinkedinBudget, ProspectPerson,
  ProspectWebReadInput, ProspectWebReadResult, ProspectLookupError,
} from "@autom8ionlab/agent-core";

export const REACH_AGENT = "friday:research-qa";
export const REACH_HOME = process.env.AGENT_REACH_HOME ?? join(homedir(), ".agent-reach");
const REACH_GUARD = process.env.REACH_GUARD_BIN ?? join(homedir(), ".local", "bin", "reach-guard");

// Mirrors reach-guard's DEFAULTS for linkedin; guard.json overrides win.
const LINKEDIN_DEFAULTS = { enabled: true, caps: { search: 10, view: 25 }, hours: [8, 18] as [number, number], weekdays_only: true };
/** The skill's own rule: at most 4 LinkedIn calls per task. */
export const MAX_LINKEDIN_CALLS_PER_LOOKUP = 4;
const MAX_PROFILES = 3;
const MAX_EXCERPT = 4_000;
const MAX_PAGE_TEXT = 200_000;

// The contract says never an email or a phone. LinkedIn's tools don't expose them, but a profile's
// free text or a search snippet can carry one the person typed in, and the raw excerpts travel
// back verbatim. This is a targeted scrub at the boundary — emails and +country phone shapes —
// not a comprehensive contact filter.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const INTL_PHONE_RE = /(^|[^\w])(\+\d{1,3}(?:[\s().-]*\d){7,})(?!\w)/g;
const US_PHONE_RE = /(^|[^\w])(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
export function redactContacts(text: string): string {
  return text.replace(EMAIL_RE, "[redacted contact]").replace(INTL_PHONE_RE, "$1[redacted contact]").replace(US_PHONE_RE, "$1[redacted contact]");
}

export interface GuardExecResult { code: number; stdout: string; stderr: string }
export interface GuardDeps {
  /** Runs `reach-guard <args…>`; tests inject a fake. */
  exec: (args: string[]) => Promise<GuardExecResult>;
  readGuardConfig: () => Record<string, unknown>;
  readGuardState: () => Record<string, unknown>;
  stopExists: () => boolean;
  now: () => Date;
}

function readJson(p: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return {}; }
}

export const defaultGuardDeps: GuardDeps = {
  exec: (args) => new Promise((resolve) => {
    // Guard-side ceiling is 240 s for the backend plus up to 120 s of deliberate pacing sleep.
    const child = spawn(REACH_GUARD, args, { env: { ...process.env, REACH_AGENT }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); stderr += "\nreach-guard: killed after 400s"; }, 400_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}\n${String(e)}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  }),
  readGuardConfig: () => readJson(join(REACH_HOME, "guard.json")),
  readGuardState: () => readJson(join(REACH_HOME, "guard-state.json")),
  stopExists: () => existsSync(join(REACH_HOME, "STOP")),
  now: () => new Date(),
};

// ── Budget (mirrors the guard's checks so we can refuse BEFORE spending a call) ───────────────
export interface LinkedinBudgetView extends ProspectLinkedinBudget {
  open: boolean;
  /** Why the platform is closed right now, when `open` is false. */
  closed_reason?: "kill_switch" | "disabled" | "locked" | "outside_hours";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function linkedinBudget(deps: Pick<GuardDeps, "readGuardConfig" | "readGuardState" | "stopExists" | "now">): LinkedinBudgetView {
  const cfgIn = isObj(deps.readGuardConfig().linkedin) ? (deps.readGuardConfig().linkedin as Record<string, unknown>) : {};
  const caps = { ...LINKEDIN_DEFAULTS.caps, ...(isObj(cfgIn.caps) ? (cfgIn.caps as Record<string, number>) : {}) };
  const hours = Array.isArray(cfgIn.hours) && cfgIn.hours.length === 2 ? (cfgIn.hours as [number, number]) : LINKEDIN_DEFAULTS.hours;
  const weekdaysOnly = typeof cfgIn.weekdays_only === "boolean" ? cfgIn.weekdays_only : LINKEDIN_DEFAULTS.weekdays_only;
  const enabled = cfgIn.enabled !== false;
  const st = isObj(deps.readGuardState().linkedin) ? (deps.readGuardState().linkedin as Record<string, unknown>) : {};
  const now = deps.now();
  const today = isObj(st.counts) && isObj((st.counts as Record<string, unknown>)[localDay(now)]) ? ((st.counts as Record<string, Record<string, number>>)[localDay(now)]) : {};
  const searches_used = Number(today.search ?? 0) || 0;
  const views_used = Number(today.view ?? 0) || 0;
  const view: LinkedinBudgetView = {
    searches_used, views_used,
    remaining_today: { searches: Math.max(0, caps.search - searches_used), views: Math.max(0, caps.view - views_used) },
    open: true,
  };
  if (deps.stopExists()) return { ...view, open: false, closed_reason: "kill_switch" };
  if (!enabled || st.disabled === true) return { ...view, open: false, closed_reason: "disabled" };
  if (typeof st.locked_until === "string" && st.locked_until > now.toISOString().slice(0, 19)) return { ...view, open: false, closed_reason: "locked" };
  const h = now.getHours();
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  if (h < hours[0] || h >= hours[1] || (weekdaysOnly && weekend)) return { ...view, open: false, closed_reason: "outside_hours" };
  return view;
}

// ── Parsers (pure) ───────────────────────────────────────────────────────────
/** mcporter `--output json` wraps the tool result as {content:[{type:"text",text}]}; the LinkedIn
 *  server's text is usually a JSON dict {url, sections:{…}, references?}. Returns the joined text
 *  plus that dict when it parses. */
export function parseGuardOutput(stdout: string): { text: string; dict?: Record<string, unknown> } {
  let text = stdout.trim();
  try {
    const j = JSON.parse(text) as unknown;
    if (isObj(j) && Array.isArray(j.content)) {
      text = (j.content as unknown[]).map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n").trim();
    } else if (isObj(j)) {
      return { text, dict: j };
    }
  } catch { /* plain text */ }
  try {
    const inner = JSON.parse(text) as unknown;
    if (isObj(inner)) return { text, dict: inner };
  } catch { /* plain text */ }
  return { text };
}

/** Flatten every `sections` value (and top-level strings) into one searchable text. */
export function sectionsText(parsed: { text: string; dict?: Record<string, unknown> }): string {
  const d = parsed.dict;
  if (d && isObj(d.sections)) {
    const parts = Object.values(d.sections as Record<string, unknown>).filter((v): v is string => typeof v === "string");
    if (parts.length) return parts.join("\n");
  }
  return parsed.text;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(inc|llc|corp|co|ltd|company|the|of|florida|fl)\b/g, " ").replace(/\s+/g, " ").trim();
export function nameSimilarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

const URL_LINE = /https?:\/\/\S+/i;
const JUNK_LINE = /^(view|see|connect|follow|message|save|about|people|posts|jobs|home|\d+(st|nd|rd|th)?)\b|\b(followers|connections|mutual)\b|·/i;
const LOCATION_LINE = /,\s*[A-Z]{2}\b|,\s*[A-Z][a-z]+,\s*United States|Area$|^Greater |United States$/;
const isLabel = (l: string) => l.length >= 2 && l.length <= 120 && !URL_LINE.test(l) && !JUNK_LINE.test(l);

/** LinkedIn search text lists one result per blank-line-separated block, name first. Returns the
 *  block around line `idx` (falling back to the URL's own line when there are no blank lines). */
function blockAround(lines: string[], idx: number): string[] {
  let a = idx, b = idx;
  while (a > 0 && lines[a - 1].trim()) a -= 1;
  while (b < lines.length - 1 && lines[b + 1].trim()) b += 1;
  return lines.slice(a, b + 1).map((l) => l.trim()).filter(Boolean);
}
/** The name of a result: the first label-like line of its block, else what sat on the URL's line. */
function blockName(block: string[], urlLine: string, fallback: string): string {
  const same = urlLine.replace(URL_LINE, "").trim();
  return block.find(isLabel) ?? (isLabel(same) ? same : fallback);
}

export interface LinkedinCompanyHit { name: string; slug: string; url: string; snippet?: string }
export function extractLinkedinCompanies(text: string): LinkedinCompanyHit[] {
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, LinkedinCompanyHit>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9._%-]+)/gi)) {
      const slug = m[1].replace(/\/$/, "");
      if (seen.has(slug)) continue;
      const block = blockAround(lines, i);
      const name = blockName(block, line, slug.replace(/[-_]+/g, " "));
      const snippet = block.filter((l) => l !== name && !URL_LINE.test(l)).join(" · ").slice(0, 200);
      seen.set(slug, { name, slug, url: `https://www.linkedin.com/company/${slug}/`, snippet: snippet || undefined });
    }
  });
  return [...seen.values()];
}

export interface LinkedinPersonHit { full_name: string; username: string; url: string; title?: string; location?: string }
export function extractLinkedinPeople(text: string): LinkedinPersonHit[] {
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, LinkedinPersonHit>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9._%-]+)/gi)) {
      const username = m[1].replace(/\/$/, "");
      if (seen.has(username)) continue;
      const block = blockAround(lines, i);
      const full_name = blockName(block, line, username.replace(/[-_]+/g, " "));
      // "Name / Title at Company / Location" top-down: the title is the first label after the name
      // that isn't a place; the location is the first place-looking line.
      const rest = block.filter((l) => l !== full_name && isLabel(l));
      const title = rest.find((l) => !LOCATION_LINE.test(l));
      const location = rest.find((l) => LOCATION_LINE.test(l));
      seen.set(username, { full_name, username, url: `https://www.linkedin.com/in/${username}/`, title: title?.slice(0, 160), location: location?.slice(0, 120) });
    }
  });
  return [...seen.values()];
}

export function parseCompanyAbout(text: string): { headcount?: string; founded?: string; hq?: string; description?: string } {
  const headcount = text.match(/\b(\d[\d,]*(?:\s*-\s*\d[\d,]*)?\+?)\s+employees\b/i)?.[1]?.replace(/\s+/g, "");
  const founded = text.match(/\bFounded\s*:?\s*(\d{4})\b/i)?.[1];
  const hq = text.match(/\bHeadquarters\s*:?\s*([^\n]{3,80})/i)?.[1]?.trim();
  const desc = text.match(/\b(?:Overview|About)\s*\n+([^\n]{20,400})/i)?.[1]?.trim();
  return { headcount, founded, hq, description: desc };
}

export function parsePersonProfile(text: string): { full_name?: string; title?: string; location?: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(isLabel);
  const full_name = lines[0]?.slice(0, 120);
  const title = lines.slice(1, 6).find((l) => /\b(owner|president|ceo|founder|manager|director|vp|partner|principal|operations|sales|marketing)\b/i.test(l)) ?? lines.slice(1).find((l) => !LOCATION_LINE.test(l));
  const location = lines.slice(1, 10).find((l) => LOCATION_LINE.test(l));
  return { full_name, title: title?.slice(0, 160), location: location?.slice(0, 120) };
}

/** Exa results as mcporter prints them: repeated "Title: … / URL: … / Published: … / Highlights: …" blocks. */
export function parseExaResults(text: string): { title: string; url: string; snippet?: string; published?: string }[] {
  const out: { title: string; url: string; snippet?: string; published?: string }[] = [];
  const blocks = text.split(/\n(?=Title:\s)/);
  for (const b of blocks) {
    const title = b.match(/^Title:\s*(.*)$/m)?.[1]?.trim();
    const url = b.match(/^URL:\s*(\S+)/m)?.[1]?.trim();
    if (!title || !url) continue;
    const published = b.match(/^Published:\s*(.*)$/m)?.[1]?.trim();
    const hl = b.split(/^Highlights:\s*$/m)[1]?.replace(/^\.\.\.$/gm, "").replace(/\s+/g, " ").trim();
    out.push({ title, url, snippet: hl ? hl.slice(0, 500) : undefined, published: published && published !== "N/A" ? published : undefined });
  }
  return out;
}

const personaMatch = (title: string | undefined, personas: string[]): string | undefined => {
  const t = (title ?? "").toLowerCase();
  return personas.find((p) => t.includes(p.toLowerCase()));
};

// ── Input validation ─────────────────────────────────────────────────────────
export function validateLinkedinInput(raw: unknown): { ok: true; input: Required<Pick<ProspectLinkedinLookupInput, "company" | "personas" | "max_profiles" | "include_company_profile">> } | { ok: false; error: string } {
  if (!isObj(raw) || !isObj(raw.company) || typeof raw.company.name !== "string" || !raw.company.name.trim()) return { ok: false, error: "company.name required" };
  const personas = Array.isArray(raw.personas) ? raw.personas.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).slice(0, 8) : [];
  if (!personas.length) return { ok: false, error: "personas required (e.g. [\"Owner\",\"President\"])" };
  const mp = typeof raw.max_profiles === "number" ? Math.max(0, Math.min(MAX_PROFILES, Math.floor(raw.max_profiles))) : 2;
  const c = raw.company as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  return {
    ok: true,
    input: {
      company: { name: String(c.name).trim().slice(0, 160), domain: str(c.domain), city: str(c.city), state: str(c.state) },
      personas, max_profiles: mp, include_company_profile: raw.include_company_profile === true,
    },
  };
}

export function validateWebReadInput(raw: unknown): { ok: true; input: ProspectWebReadInput } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "input required" };
  if (raw.mode === "read") {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: "mode=read needs one http(s) url" };
    return { ok: true, input: { mode: "read", url } };
  }
  if (raw.mode === "search") {
    const query = typeof raw.query === "string" ? raw.query.trim().slice(0, 300) : "";
    if (!query) return { ok: false, error: "mode=search needs a query" };
    const n = typeof raw.num_results === "number" ? Math.max(1, Math.min(10, Math.floor(raw.num_results))) : 8;
    return { ok: true, input: { mode: "search", query, num_results: n } };
  }
  return { ok: false, error: "mode must be read or search" };
}

// ── Guard exit-code classification ───────────────────────────────────────────
function guardFailure(kind: ProspectLookupError["kind"], r: GuardExecResult, budget?: ProspectLinkedinBudget): ProspectLookupError | null {
  if (r.code === 0) return null;
  const err = (r.stderr || r.stdout || `reach-guard exit ${r.code}`).trim().slice(-600);
  if (r.code === 75) return { ok: false, kind, error: err, locked: true, budget };
  if (r.code === 69) return { ok: false, kind, error: err, not_logged_in: true, budget };
  if (r.code === 64) return { ok: false, kind, error: err, refused: true, budget };
  return { ok: false, kind, error: err, budget };
}

// ── LinkedIn lookup ──────────────────────────────────────────────────────────
export async function linkedinLookup(rawInput: unknown, deps: GuardDeps = defaultGuardDeps): Promise<ProspectLinkedinLookupResult | ProspectLookupError> {
  const kind = "prospect.linkedin_lookup" as const;
  const v = validateLinkedinInput(rawInput);
  if (!v.ok) return { ok: false, kind, error: v.error, invalid_input: true };
  const { company, personas, max_profiles, include_company_profile } = v.input;
  const observed_at = deps.now().toISOString();
  const excerpts: { call: string; text: string }[] = [];
  const people: ProspectPerson[] = [];
  let searches = 0, views = 0;
  const budget0 = linkedinBudget(deps);
  const budget = (): ProspectLinkedinBudget => ({
    searches_used: budget0.searches_used + searches, views_used: budget0.views_used + views,
    remaining_today: { searches: Math.max(0, budget0.remaining_today.searches - searches), views: Math.max(0, budget0.remaining_today.views - views) },
  });
  let company_profile: ProspectLinkedinLookupResult["company_profile"];
  const skipped = (reason: string): ProspectLinkedinLookupResult => ({ ok: true, kind, company_profile, people, budget: budget(), skipped_reason: reason, raw_excerpts: excerpts, observed_at });

  // Refuse before spending: the guard would refuse too, but a refused call still counts a search.
  if (!budget0.open) return skipped(`linkedin_${budget0.closed_reason}`);
  const wantedSearches = 2, wantedViews = max_profiles + (include_company_profile ? 1 : 0);
  if (budget0.remaining_today.searches < 1) return skipped("linkedin_budget_exhausted");
  if (budget0.remaining_today.searches < wantedSearches || budget0.remaining_today.views < Math.min(wantedViews, 1)) {
    // Not enough for a full lookup; do what fits rather than nothing, and say so.
    excerpts.push({ call: "budget", text: `only ${budget0.remaining_today.searches} searches / ${budget0.remaining_today.views} views left today` });
  }
  let calls = 0;
  const call = async (verb: string, args: string[], cls: "search" | "view"): Promise<{ text: string; dict?: Record<string, unknown> } | ProspectLookupError> => {
    if (calls >= MAX_LINKEDIN_CALLS_PER_LOOKUP) return { ok: false, kind, error: "per-lookup call ceiling reached", refused: true, budget: budget() };
    calls += 1;
    if (cls === "search") searches += 1; else views += 1; // the guard counts the attempt, success or not
    const r = await deps.exec(["linkedin", verb, ...args, "--output", "json"]);
    const f = guardFailure(kind, r, budget());
    if (f) return f;
    const parsed = parseGuardOutput(r.stdout);
    excerpts.push({ call: `${verb} ${args.join(" ")}`.slice(0, 200), text: redactContacts(sectionsText(parsed)).slice(0, MAX_EXCERPT) });
    return parsed;
  };
  const isErr = (x: unknown): x is ProspectLookupError => isObj(x) && x.ok === false;
  // A refusal mid-way (cap hit on the second call) keeps what was gathered; a lock or a logout is
  // reported as the error it is — the owner must hear about those.
  const stopOn = (e: ProspectLookupError): ProspectLinkedinLookupResult | ProspectLookupError =>
    e.refused ? skipped(`linkedin_refused: ${e.error.split("\n").pop()?.slice(0, 200) ?? ""}`) : e;

  // 1) company search → best slug match on name (+ domain hint in the snippet).
  const kw = [company.name, company.city, company.state].filter(Boolean).join(" ");
  const cs = await call("search_companies", [`keywords=${kw}`], "search");
  if (isErr(cs)) return stopOn(cs);
  const companies = extractLinkedinCompanies(sectionsText(cs));
  const best = companies
    .map((c) => ({ c, score: nameSimilarity(c.name, company.name) + (company.domain && c.snippet?.toLowerCase().includes(company.domain.toLowerCase()) ? 0.3 : 0) }))
    .sort((a, b) => b.score - a.score)[0];
  const match = best && best.score >= 0.34 ? best.c : undefined;
  if (match) company_profile = { linkedin_url: match.url };
  let urn: string | undefined;

  // 2) optional company page (one view) — headcount/founded/HQ and the URN people-search needs.
  if (match && include_company_profile && budget().remaining_today.views > 0) {
    const cp = await call("get_company_profile", [`company_name=${match.slug}`], "view");
    if (isErr(cp)) return stopOn(cp);
    const about = parseCompanyAbout(sectionsText(cp));
    company_profile = { linkedin_url: match.url, ...about };
    const refs = cp.dict && isObj(cp.dict.references) ? (cp.dict.references as Record<string, unknown>).about : undefined;
    if (Array.isArray(refs)) urn = refs.map((r) => (isObj(r) && r.kind === "company_urn" && typeof r.value === "string" ? r.value : undefined)).find(Boolean);
  }

  // 3) people search — one search covers every persona; titles are filtered locally.
  if (budget().remaining_today.searches < 1) return skipped("linkedin_budget_exhausted");
  const psArgs = [`keywords=${match?.name ?? company.name}`];
  const loc = [company.city, company.state].filter(Boolean).join(", ");
  if (loc) psArgs.push(`location=${loc}`);
  if (urn) psArgs.push(`current_company=${urn}`);
  const ps = await call("search_people", psArgs, "search");
  if (isErr(ps)) return stopOn(ps);
  const hits = extractLinkedinPeople(sectionsText(ps));
  const ranked = hits
    .map((h) => ({ h, persona: personaMatch(h.title, personas), companyHit: nameSimilarity(h.title ?? "", company.name) > 0 }))
    .sort((a, b) => {
      const pa = a.persona ? personas.indexOf(a.persona) : 99, pb = b.persona ? personas.indexOf(b.persona) : 99;
      return pa - pb || Number(b.companyHit) - Number(a.companyHit);
    });
  for (const { h, persona } of ranked) {
    people.push({
      full_name: redactContacts(h.full_name), title: h.title && redactContacts(h.title), linkedin_url: h.url, location: h.location && redactContacts(h.location),
      confidence: persona ? 0.6 : 0.4, source_url: h.url, observed_at, matched_persona: persona,
    });
  }

  // 4) open up to max_profiles profiles, persona matches first — each is one view.
  const toOpen = people.filter((p) => p.matched_persona).slice(0, max_profiles);
  for (const p of toOpen) {
    if (budget().remaining_today.views < 1) { excerpts.push({ call: "budget", text: "no profile views left today; search-only confidence kept" }); break; }
    const username = p.linkedin_url.match(/\/in\/([^/]+)\/?$/)?.[1];
    if (!username) continue;
    const pp = await call("get_person_profile", [`linkedin_username=${username}`], "view");
    if (isErr(pp)) { if (pp.refused) { excerpts.push({ call: "refused", text: pp.error.slice(0, 300) }); break; } return pp; }
    const prof = parsePersonProfile(sectionsText(pp));
    if (prof.title) p.title = redactContacts(prof.title);
    if (prof.location) p.location = redactContacts(prof.location);
    const stillMatches = personaMatch(p.title, personas);
    p.matched_persona = stillMatches ?? p.matched_persona;
    p.confidence = stillMatches ? 0.9 : 0.7;
  }

  return { ok: true, kind, company_profile, people, budget: budget(), raw_excerpts: excerpts, observed_at };
}

// ── Web read / search ────────────────────────────────────────────────────────
export async function webRead(rawInput: unknown, deps: GuardDeps = defaultGuardDeps): Promise<ProspectWebReadResult | ProspectLookupError> {
  const kind = "prospect.web_read" as const;
  const v = validateWebReadInput(rawInput);
  if (!v.ok) return { ok: false, kind, error: v.error, invalid_input: true };
  const fetched_at = deps.now().toISOString();
  if (v.input.mode === "read") {
    const r = await deps.exec(["web", "read", v.input.url!]);
    const f = guardFailure(kind, r);
    if (f) return f;
    return { ok: true, kind, mode: "read", text: r.stdout.slice(0, MAX_PAGE_TEXT), fetched_at, source: "jina" };
  }
  const r = await deps.exec(["web", "search", `query=${v.input.query}`, `numResults=${v.input.num_results ?? 8}`, "--output", "json"]);
  const f = guardFailure(kind, r);
  if (f) return f;
  const results = parseExaResults(parseGuardOutput(r.stdout).text);
  return { ok: true, kind, mode: "search", results, fetched_at, source: "exa" };
}
