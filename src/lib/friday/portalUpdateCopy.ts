// FRIDAY — client-portal update copy: the PURE half of portalUpdates.
//
// Everything here is deterministic and network-free except composeSections (one LLM call via
// engines.complete). portalUpdates.ts owns GitHub reads, cursors and posting; the backfill CLI reuses
// both. Keeping this module pure is what lets the classifier, validator and fallback be unit-tested.
//
// What a client sees (payload.sections, rendered as labelled sections on the portal):
//   context  — What took place: why this work happened / what was asked
//   changes  — What we did
//   impact   — How it affects your software (by screen / feature)
//   live_now — What's live now (merge to the default branch == live, owner rule 2026-09-23)
//   check    — What to check (optional, 0-5 short things to try)
//
// Readers are business owners, not developers. The validator rejects anything that smells like
// engineering (paths, PR numbers, agent names, framework names) and the deterministic fallback is
// built from feature-area names so even a total LLM outage yields a readable, honest entry.

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChangedFile { path: string; additions: number; deletions: number; status?: string }
export interface UnitCommit { sha: string; subject: string; body: string }
export type UnitKind = "feature" | "fix" | "content" | "maintenance";

/** One thing worth (maybe) telling the client about: a merged PR, a merge commit, or a day's direct commits. */
export interface WorkUnit {
  kind: "pr" | "merge" | "commit-digest";
  /** Stable dedupe key: pr#N | merge-<sha7> | commits-<YYYY-MM-DD>-<sha7>. */
  ref: string;
  title: string;
  body: string;
  url?: string;
  commits: UnitCommit[];
  files: ChangedFile[];
  occurredAt: string; // ISO
  /** Linked request context, when FRIDAY can find the task/ticket that asked for it. */
  request?: { asked: string; by?: string; kind?: string };
}

export interface UpdateSections {
  context: string;
  changes: string;
  impact: string;
  live_now: string;
  check?: string[];
}

export interface UpdateEntry {
  title: string;
  sections: UpdateSections;
  /** Plain-text concatenation of the sections — the legacy `detail` field. */
  detail: string;
  kind: UnitKind;
  is_live: boolean;
  /** How the copy was produced — surfaces in logs so quality regressions are visible. */
  via: "llm" | "llm-repaired" | "fallback";
}

export interface ComposeCtx {
  projectName: string;
  /** live: merged to the default branch. pending: a build awaiting the client's go-ahead (release approvals). */
  mode: "live" | "pending";
}

// Section caps. Together with the headings they keep `detail` under the MCP tool's 4000-char cap.
export const CAPS = { title: 90, context: 500, changes: 800, impact: 800, live_now: 300, check: 160, checkItems: 5 } as const;

// ── Feature areas (paths → words a client recognises) ───────────────────────

const NOISE_BUCKETS: Array<{ reason: string; test: (p: string) => boolean }> = [
  { reason: "lockfile", test: (p) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(p) },
  { reason: "deps", test: (p) => /(^|\/)(package\.json|\.nvmrc|\.npmrc|\.node-version|renovate\.json|\.github\/dependabot\.ya?ml)$/.test(p) },
  { reason: "ci", test: (p) => /^\.github\//.test(p) || /(^|\/)(netlify\.toml|vercel\.json|CODEOWNERS|Dockerfile|\.dockerignore|\.editorconfig|\.gitignore|\.gitattributes)$/.test(p) },
  { reason: "tooling", test: (p) => /^(scripts?|tools?|bin|\.husky|\.vscode|\.idea)\//.test(p) || /(^|\/)(lib|src)\/scripts?\//.test(p) || /(^|\/)(eslint\.config\.\w+|\.eslintrc(\.\w+)?|\.prettierrc(\.\w+)?|prettier\.config\.\w+|tsconfig(\.\w+)?\.json|postcss\.config\.\w+|tailwind\.config\.\w+|next\.config\.\w+|vite\.config\.\w+|vitest\.config\.\w+|playwright\.config\.\w+|jest\.config\.\w+|babel\.config\.\w+)$/.test(p) },
  { reason: "internal-docs", test: (p) => (/\.(md|mdx)$/i.test(p) && !/^(content|src|app|pages|public)\//.test(p)) || /^(docs|\.claude|\.cursor|\.codex)\//.test(p) || /(^|\/)(AGENTS|CLAUDE|CONVENTIONS)\.md$/.test(p) || /^[^/]*(audit|reports?|research|notes|scratch|findings)[^/]*\//i.test(p) },
  { reason: "tests", test: (p) => /(^|\/)(__tests__|e2e|tests?)\//.test(p) || /\.(test|spec)\.\w+$/.test(p) || /(^|\/)(playwright|vitest|jest)[\w.-]*\.(ts|js|mjs)$/.test(p) },
  { reason: "generated", test: (p) => /\.snap$/.test(p) || /(^|\/)(dist|build|\.next|out|coverage)\//.test(p) },
];

export function noiseBucket(path: string): string | null {
  for (const b of NOISE_BUCKETS) if (b.test(path)) return b.reason;
  return null;
}

// Abbreviations that show up as folder names but mean something specific to the client.
const VOCAB: Record<string, string> = {
  gads: "Google Ads", ppc: "Paid ads", seo: "SEO", gbp: "Google Business Profile", ghl: "GoHighLevel", crm: "CRM",
  faq: "FAQ", faqs: "FAQs", cta: "Call to action", ctas: "Calls to action", ui: "Interface", ux: "Experience",
  auth: "Sign-in", login: "Sign-in", signup: "Sign-up", dashboard: "Dashboard", admin: "Admin area",
  landers: "Landing Pages", lander: "Landing Page", lp: "Landing Page", blog: "Blog", nav: "Navigation", footer: "Footer", header: "Header",
};

const humanize = (s: string): string =>
  s.replace(/\.[a-z0-9]+$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => VOCAB[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

/** Map a changed-file path to a name a client would recognise, or null when it's housekeeping. */
export function featureAreaOf(rawPath: string): string | null {
  if (noiseBucket(rawPath)) return null;
  let p = rawPath.replace(/^\.\//, "");
  // Data / backend buckets first — their folder names are meaningful before prefix stripping.
  if (/(^|\/)(supabase\/migrations|prisma\/migrations|migrations|drizzle)\//.test(p) || /\.sql$/.test(p)) return "Data storage";
  const fn = p.match(/(^|\/)(supabase|netlify)\/(edge-)?functions\/([^/]+)/);
  if (fn) return `Background service: ${humanize(fn[4])}`;
  if (/(^|\/)(emails?|mail|templates\/email)\//i.test(p)) return "Emails";
  if (/(^|\/)(content|public|static|assets|images?|img|media|fonts?)\//i.test(p) || /\.(png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|pdf|woff2?|ttf)$/i.test(p)) return "Site content and images";
  if (/(^|\/)(styles?|css|theme)\//i.test(p) || /\.(css|scss|sass|less)$/i.test(p)) return "Look and feel";

  // Strip monorepo / framework prefixes.
  p = p.replace(/^(apps|packages|services)\/[^/]+\//, "").replace(/^(src|source)\//, "");
  const segs = p.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !/^\[.*\]$/.test(s) && s !== "index");
  if (!segs.length) return null;
  const file = segs[segs.length - 1].replace(/\.[a-z0-9]+$/i, "");
  const isRouteFile = /^(page|layout|route|loading|error|template|default|not-found|\+page|\+layout|\+server)$/.test(file);
  const head = segs[0].toLowerCase();

  if (head === "api" || head === "server" || segs.includes("api")) {
    const i = segs.findIndex((s) => s.toLowerCase() === "api");
    const next = segs[i + 1] && !(i + 1 === segs.length - 1 && isRouteFile) ? segs[i + 1] : segs[i + 1] ?? "";
    return next ? `${humanize(next)} (behind the scenes)` : "Behind the scenes";
  }
  if (/^(lib|libs|utils?|helpers?|hooks?|shared|core|common|config|types?|schemas?|store|state|middleware|db|database|scripts?|bin|infra|internal)$/.test(head)) {
    return "Shared logic (behind the scenes)";
  }
  if (/^(components?|ui|widgets?|features?|modules?|views?|screens?)$/.test(head)) {
    const name = segs.length >= 3 ? segs[1] : segs.length === 2 ? segs[1] : "";
    if (!name) return "Interface elements";
    return humanize(name.replace(/\.[a-z0-9]+$/i, ""));
  }
  if (/^(app|pages|routes)$/.test(head)) {
    const rest = segs.slice(1);
    const named = rest.filter((s, i) => !(i === rest.length - 1 && isRouteFile));
    if (!named.length) return "Home page";
    const parts = named.slice(0, 2).map(humanize);
    return parts.join(" › ");
  }
  // Fallback: top-level folder, or the file name at the root.
  if (segs.length === 1) return isRouteFile ? "Home page" : humanize(file);
  return humanize(segs[0]);
}

export interface FeatureArea { area: string; files: number; churn: number }

export function featureAreas(files: ChangedFile[]): FeatureArea[] {
  const agg = new Map<string, FeatureArea>();
  for (const f of files) {
    const area = featureAreaOf(f.path);
    if (!area) continue;
    const cur = agg.get(area) ?? { area, files: 0, churn: 0 };
    cur.files += 1;
    cur.churn += (f.additions || 0) + (f.deletions || 0);
    agg.set(area, cur);
  }
  return [...agg.values()].sort((a, b) => b.churn - a.churn || b.files - a.files).slice(0, 8);
}

// ── Classifier ──────────────────────────────────────────────────────────────

const TITLE_NOISE: Array<{ reason: string; re: RegExp }> = [
  { reason: "deps", re: /\b(deps|dependenc(?:y|ies)|bumps?|bumped|lockfile|dependabot|renovate|patch bumps)\b/i },
  { reason: "ci", re: /\bci\b|failing checks|typecheck|type-check|\blint\b|line endings|stray junk|esbuild/i },
  { reason: "chore", re: /^\s*chore\b/i },
  { reason: "revert-tooling", re: /^\s*revert\b.*\b(typescript|deps?|bump|lockfile|eslint|node)\b/i },
];

export interface Classification { noise: boolean; reason?: string; kind: UnitKind }

/**
 * Files decide; the title only breaks ties when no file list is available. A unit is noise only when
 * EVERY changed file is housekeeping — a real feature that also bumps the lockfile is still a feature.
 */
export function classifyUnit(unit: Pick<WorkUnit, "title" | "files" | "commits">): Classification {
  const files = unit.files ?? [];
  if (files.length) {
    const buckets = files.map((f) => noiseBucket(f.path));
    if (buckets.every(Boolean)) {
      const counts = new Map<string, number>();
      for (const b of buckets) counts.set(b as string, (counts.get(b as string) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { noise: true, reason: top, kind: "maintenance" };
    }
  } else {
    const subjects = [unit.title, ...(unit.commits ?? []).map((c) => c.subject)].filter(Boolean);
    const hits = subjects.map((s) => TITLE_NOISE.find((t) => t.re.test(s))?.reason ?? null);
    if (subjects.length && hits.every(Boolean)) return { noise: true, reason: hits[0] as string, kind: "maintenance" };
  }
  const contentOnly = files.length > 0 && files.every((f) => noiseBucket(f.path) || featureAreaOf(f.path) === "Site content and images");
  if (contentOnly) return { noise: false, kind: "content" };
  const t = unit.title ?? "";
  if (/^\s*(fix|hotfix|bugfix|bug)\b|\bbroken\b|\bfix(?:es|ed)?\b|^\s*revert\b/i.test(t)) return { noise: false, kind: "fix" };
  return { noise: false, kind: "feature" };
}

// ── Validator ───────────────────────────────────────────────────────────────

const AGENT_NAMES = /\b(FRIDAY|CLARA|Claude|Codex|CodeRabbit|Copilot|GPT|OpenAI|Hermes|LM ?Studio)\b/;
const TASKBOARD = /\[(?:QA|(?:Fix|Review|Rebase)(?:\s*R\d+)?)\]|VERDICT:|\bqa_testing\b|\bsquash\b/i;
const FILE_PATH = /(?:^|[\s("'`])(?:[\w@.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|sql|mdx?|css|scss|ya?ml|toml|lock|env|html|py|rb|go|rs)\b|\.(?:tsx?|jsx?|sql|ya?ml)\b/i;
const BRANCHY = /(?:^|[\s(])(?:origin\/|feat\/|fix\/|chore\/|friday\/|main\b\s*branch)/i;
const PR_REFS = /#\d{1,6}\b|\bPRs?\b|\bpull requests?\b/i;
const HEX_SHA = /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*\d[0-9a-f]*\b/;
const JARGON = /\b(refactor(?:ed|ing|s)?|chore|deps|typecheck|lint(?:er|ing)?|lockfiles?|dependenc(?:y|ies)|npm|yarn|pnpm|typescript|javascript|react|next\.?js|tailwind|supabase|netlify|vercel|github|repo(?:sitory|sitories)?|branch(?:es)?|commits?|merged?|squash|deploy(?:ed|ment|s)?|\bCI\b|pipelines?|migrations?|endpoints?|APIs?|backend|frontend|middleware|webhooks?|schemas?|regex|codebase|codepath|boilerplate)\b/i;
const VERSION = /\bv?\d+\.\d+\.\d+\b/;
const PLACEHOLDER = /\{[a-z0-9_ .-]+\}|\[[a-z0-9_ .-]+\]|\bTBD\b|\blorem\b|X{3,}/i;
const MONEY = /\$\s?\d/;

function textIssues(field: string, text: string): string[] {
  const out: string[] = [];
  if (AGENT_NAMES.test(text)) out.push(`${field}: names an internal agent/tool`);
  if (TASKBOARD.test(text)) out.push(`${field}: task-board jargon`);
  if (FILE_PATH.test(text)) out.push(`${field}: contains a file path or extension`);
  if (BRANCHY.test(text)) out.push(`${field}: contains a branch name`);
  if (PR_REFS.test(text)) out.push(`${field}: references a PR/issue number`);
  if (HEX_SHA.test(text)) out.push(`${field}: contains a commit hash`);
  const j = text.match(JARGON);
  if (j) out.push(`${field}: developer jargon ("${j[0]}")`);
  if (VERSION.test(text)) out.push(`${field}: version number`);
  if (PLACEHOLDER.test(text)) out.push(`${field}: placeholder token`);
  if (MONEY.test(text)) out.push(`${field}: dollar figure`);
  if (/[*_#`]{2}|^\s*[-*]\s|^#+\s/m.test(text)) out.push(`${field}: markdown formatting`);
  return out;
}

export function sectionIssues(entry: { title: string; sections: UpdateSections }, mode: ComposeCtx["mode"] = "live"): string[] {
  const issues: string[] = [];
  const { title, sections: s } = entry;
  const len = (v: string | undefined) => (v ?? "").trim().length;
  if (len(title) < 8 || len(title) > CAPS.title) issues.push(`title: must be 8–${CAPS.title} chars`);
  if (len(s.context) < 40 || len(s.context) > CAPS.context) issues.push(`context: must be 40–${CAPS.context} chars`);
  if (len(s.changes) < 60 || len(s.changes) > CAPS.changes) issues.push(`changes: must be 60–${CAPS.changes} chars`);
  if (len(s.impact) < 40 || len(s.impact) > CAPS.impact) issues.push(`impact: must be 40–${CAPS.impact} chars`);
  if (len(s.live_now) < 20 || len(s.live_now) > CAPS.live_now) issues.push(`live_now: must be 20–${CAPS.live_now} chars`);
  if (mode === "live" && !/\blive\b|\bnow (?:on|in) your\b/i.test(s.live_now ?? "")) issues.push("live_now: must say plainly that the change is live");
  if (mode === "pending" && !/\bnot (?:yet )?live\b|\bready\b|\bwaiting\b|\bgo-ahead\b/i.test(s.live_now ?? "")) issues.push("live_now: must say it is ready and waiting for the client's go-ahead");
  if (mode === "pending" && /\bis (?:now )?live\b/i.test(s.live_now ?? "")) issues.push("live_now: claims live in pending mode");
  const check = s.check ?? [];
  if (check.length > CAPS.checkItems) issues.push(`check: at most ${CAPS.checkItems} items`);
  if (new Set(check.map((c) => c.trim().toLowerCase())).size !== check.length) issues.push("check: duplicate items");
  for (const c of check) if (len(c) < 15 || len(c) > CAPS.check) issues.push(`check: each item 15–${CAPS.check} chars`);

  issues.push(...textIssues("title", title));
  issues.push(...textIssues("context", s.context ?? ""));
  issues.push(...textIssues("changes", s.changes ?? ""));
  issues.push(...textIssues("impact", s.impact ?? ""));
  issues.push(...textIssues("live_now", s.live_now ?? ""));
  check.forEach((c, i) => issues.push(...textIssues(`check[${i}]`, c)));
  return issues;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You write short project updates for a small-business owner who is NOT technical. They use the software every day " +
  "but do not know what code, branches, files, servers or pull requests are. Explain it the way a good account manager " +
  "would in a two-minute phone call: what prompted the work, what the team changed, what they will notice on which screen, " +
  "and whether it is live.\n\n" +
  "Voice: first person plural (\"we\"), plain English, confident, concrete. Say \"you\" / \"your team\" for the client. " +
  "Prefer screen and feature names (\"the Leads page\", \"the contact form\") over anything technical. Impact before mechanism. " +
  "If something was removed or reverted, say so plainly and why.\n\n" +
  "NEVER include: file names or paths, folder names, branch names, commit or pull-request numbers, version numbers, library " +
  "or framework names, agent or tool names (FRIDAY, Claude, Codex, CI), the words refactor/chore/lint/dependency/lockfile/" +
  "merge/deploy/repo/PR/squash/API/endpoint/migration, dollar figures, dates you were not given, or anything not supported " +
  "by the material. Do not invent benefits. No markdown, no bullets, no headings.\n\n" +
  "Return ONLY a JSON object with exactly these keys:\n" +
  "{\n" +
  `  "title":    "headline, max ${CAPS.title - 10} chars, states the benefit (e.g. 'Faster ad landing pages with a simpler form')",\n` +
  `  "context":  "1-2 sentences: why this work happened / what was asked. Use the request context if given; otherwise say what problem or goal it addressed. Max ${CAPS.context - 100} chars.",\n` +
  `  "changes":  "2-4 sentences: what we did, in product terms. Max ${CAPS.changes - 100} chars.",\n` +
  `  "impact":   "2-4 sentences: what they will notice and where, naming screens/features/areas. If they will notice nothing (behind-the-scenes), say that honestly in one sentence. Max ${CAPS.impact - 100} chars.",\n` +
  `  "live_now": "1-2 sentences. In live mode: state clearly that this is now live on their site/app. In pending mode: state that it is ready and waiting for their go-ahead and is NOT live yet. Max ${CAPS.live_now - 50} chars.",\n` +
  `  "check":    ["0-4 short things the client may want to try or look at to confirm it works as they expect; each one imperative sentence naming the screen, max ${CAPS.check - 20} chars. Empty array if nothing is worth checking."]\n` +
  "}";

export function buildPromptInput(unit: WorkUnit, ctx: ComposeCtx): string {
  const areas = featureAreas(unit.files);
  const noiseFiles = unit.files.filter((f) => noiseBucket(f.path)).length;
  const adds = unit.files.reduce((n, f) => n + (f.additions || 0), 0);
  const dels = unit.files.reduce((n, f) => n + (f.deletions || 0), 0);
  const commits = unit.commits
    .map((c) => `- ${c.subject.slice(0, 160)}${c.body ? `\n  ${c.body.replace(/\s+/g, " ").slice(0, 300)}` : ""}`)
    .join("\n")
    .slice(0, 2500);
  const request = unit.request
    ? `${unit.request.asked.slice(0, 800)}${unit.request.by ? ` — asked by ${unit.request.by}` : ""}`
    : "(none recorded)";
  return [
    `Project: ${ctx.projectName}`,
    `Mode: ${ctx.mode}`,
    `Landed: ${unit.occurredAt.slice(0, 10)}`,
    ``,
    `Request context (what was asked, if known):`,
    request,
    ``,
    `Change title (internal, do not quote verbatim): ${unit.title.slice(0, 200)}`,
    ``,
    `Description written by the developer (internal):`,
    unit.body.trim().slice(0, 3000) || "(none)",
    ``,
    `Individual changes (internal notes, oldest first):`,
    commits || "(none)",
    ``,
    `Areas of the software touched (derived from changed files; use these names for "impact" and "check"):`,
    areas.length ? areas.map((a) => `- ${a.area}: ${a.files} file(s), ${a.churn} lines changed`).join("\n") : "(unknown)",
    ``,
    `Size of change: ${unit.files.length} files, +${adds} / -${dels} lines.`,
    `Housekeeping files (ignore for the client narrative): ${noiseFiles}`,
    ``,
    `Write the JSON now.`,
  ].join("\n");
}

interface LlmSections { title?: string; context?: string; changes?: string; impact?: string; live_now?: string; check?: unknown }

function coerce(raw: LlmSections | null): { title: string; sections: UpdateSections } | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const check = Array.isArray(raw.check) ? raw.check.map(str).filter(Boolean).slice(0, CAPS.checkItems) : [];
  const out = {
    title: str(raw.title),
    sections: { context: str(raw.context), changes: str(raw.changes), impact: str(raw.impact), live_now: str(raw.live_now), check },
  };
  if (!out.title || !out.sections.context || !out.sections.changes || !out.sections.impact || !out.sections.live_now) return null;
  return out;
}

async function askModel(system: string, prompt: string, timeoutMs: number): Promise<{ title: string; sections: UpdateSections } | null> {
  try {
    const { completeJSON } = await import("@/lib/friday/engines");
    const raw = await completeJSON<LlmSections>({ system, prompt, temperature: 0.3, timeoutMs, json: true });
    return coerce(raw);
  } catch {
    return null;
  }
}

export async function composeSections(unit: WorkUnit, ctx: ComposeCtx): Promise<{ title: string; sections: UpdateSections } | null> {
  return askModel(SYSTEM_PROMPT, buildPromptInput(unit, ctx), 90_000);
}

async function repairSections(
  draft: { title: string; sections: UpdateSections },
  issues: string[],
  ctx: ComposeCtx,
): Promise<{ title: string; sections: UpdateSections } | null> {
  const prompt =
    `Mode: ${ctx.mode}\n\nCurrent draft (JSON):\n${JSON.stringify({ title: draft.title, ...draft.sections }, null, 2)}\n\n` +
    `Violations to fix:\n- ${issues.join("\n- ")}\n\nReturn the corrected JSON object only, same keys.`;
  return askModel(SYSTEM_PROMPT + "\n\nYou are now EDITING a draft to fix the listed violations while keeping its meaning.", prompt, 60_000);
}

// ── Deterministic fallback ──────────────────────────────────────────────────

/** Strip conventional-commit prefixes, PR suffixes, branch-ish tokens and dev words from a title. */
export function humanizeTitle(raw: string): string {
  let t = raw.split("\n")[0]
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/^\s*(?:feat|fix|chore|docs|refactor|perf|test|ci|build|style|revert|hotfix)(?:\([^)]*\))?!?:\s*/i, "")
    .replace(/^\s*(?:origin\/|friday\/|feat\/|fix\/|chore\/)/i, "")
    .replace(/\[(?:QA|Fix(?:\s*R\d+)?)\]/gi, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop tokens the validator would reject rather than let a dirty title block the post.
  t = t.split(" ").filter((w) => !(JARGON.test(w) || FILE_PATH.test(w) || HEX_SHA.test(w) || VERSION.test(w) || AGENT_NAMES.test(w) || /^#\d+$/.test(w))).join(" ");
  t = t.replace(/\s+/g, " ").replace(/^[\s:—-]+|[\s:—-]+$/g, "").trim();
  if (t.length < 8) return "";
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > CAPS.title - 10 ? t.slice(0, CAPS.title - 13).replace(/\s+\S*$/, "") + "…" : t;
}

/** Areas a client can't "open": internal plumbing, storage, background services. */
export const isBackstage = (area: string): boolean => /\(behind the scenes\)|^Data storage$|^Background service:|^Shared logic/.test(area);

function listAreas(areas: FeatureArea[], max: number): string {
  const names = areas.slice(0, max).map((a) => a.area);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Best human title for a unit: the PR title, or for a digest the most descriptive non-noise commit subject. */
export function unitHeadline(unit: Pick<WorkUnit, "kind" | "title" | "commits" | "files">): string {
  if (unit.kind !== "commit-digest" || unit.commits.length <= 1) return humanizeTitle(unit.title);
  const candidates = unit.commits
    .filter((c) => !TITLE_NOISE.some((t) => t.re.test(c.subject)) && !/^merge\b/i.test(c.subject))
    .map((c) => humanizeTitle(c.subject))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return "";
  const best = candidates[0];
  const more = unit.commits.length - 1;
  const suffix = more > 0 ? ` and ${more} other improvement${more === 1 ? "" : "s"}` : "";
  return (best + suffix).length <= CAPS.title - 10 ? best + suffix : best;
}

export function fallbackEntry(unit: WorkUnit, ctx: ComposeCtx, kind: UnitKind): { title: string; sections: UpdateSections } {
  const areas = featureAreas(unit.files);
  const visible = areas.filter((a) => !isBackstage(a.area));
  const top = (visible[0] ?? areas[0])?.area;
  const areaList = listAreas(visible.length ? visible : areas, 3);
  const verb = kind === "fix" ? "fixed" : kind === "content" ? "updated the content of" : "improved";
  const subject = unitHeadline(unit) || (top ? `an update to ${top}` : "an improvement to the project");
  const title = subject;

  const context = unit.request?.asked
    ? `You asked us to ${unit.request.asked.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, 300)}.`
    : `This was part of the ongoing improvement work on ${ctx.projectName}: ${kind === "fix" ? "we found and corrected a problem" : "we made the product work better for you"}.`;

  const n = unit.commits.length || 1;
  const lower = subject.charAt(0).toLowerCase() + subject.slice(1);
  const howMany = n > 1 ? ` This was done in ${n} separate changes that we tested before releasing.` : " We tested it before releasing.";
  const changes = areaList
    ? `We ${verb} ${lower}. The work covered ${areaList}.${howMany}`
    : `We ${verb} ${lower}.${howMany}`;

  const impact = visible.length
    ? `You may notice changes in ${listAreas(visible, 4)}. Everything else works the way it did before.`
    : `This is a behind-the-scenes change, so you should not notice anything different in day-to-day use.`;

  const live_now = ctx.mode === "live"
    ? `This change is live on your site as of ${longDate(unit.occurredAt)}.`
    : `This change is built and waiting for your go-ahead before it goes live.`;

  const check = visible.slice(0, 3).map((a) => `Open ${a.area} and confirm it looks and behaves the way you expect.`);
  return { title, sections: { context, changes, impact, live_now, check } };
}

// ── Assembly ────────────────────────────────────────────────────────────────

export function sectionsToText(s: UpdateSections): string {
  const parts = [
    `What took place\n${s.context}`,
    `What we did\n${s.changes}`,
    `How it affects your software\n${s.impact}`,
    `What's live now\n${s.live_now}`,
  ];
  if (s.check?.length) parts.push(`What to check\n${s.check.map((c) => `- ${c}`).join("\n")}`);
  return parts.join("\n\n").slice(0, 4000);
}

/**
 * LLM → validate → one repair pass → validate → deterministic fallback. Never throws, never blocks a
 * post. `via` says which path produced the copy so the job can log fallbacks.
 */
export async function composeEntry(unit: WorkUnit, ctx: ComposeCtx, opts: { noLlm?: boolean } = {}): Promise<UpdateEntry & { issues?: string[] }> {
  const cls = classifyUnit(unit);
  const finish = (d: { title: string; sections: UpdateSections }, via: UpdateEntry["via"], issues?: string[]): UpdateEntry & { issues?: string[] } => ({
    title: d.title.slice(0, 118),
    sections: d.sections,
    detail: sectionsToText(d.sections),
    kind: cls.kind,
    is_live: ctx.mode === "live",
    via,
    ...(issues?.length ? { issues } : {}),
  });

  if (!opts.noLlm) {
    const first = await composeSections(unit, ctx);
    if (first) {
      const issues = sectionIssues(first, ctx.mode);
      if (!issues.length) return finish(first, "llm");
      const fixed = await repairSections(first, issues, ctx);
      if (fixed) {
        const again = sectionIssues(fixed, ctx.mode);
        if (!again.length) return finish(fixed, "llm-repaired");
        return finish(fallbackEntry(unit, ctx, cls.kind), "fallback", again);
      }
      return finish(fallbackEntry(unit, ctx, cls.kind), "fallback", issues);
    }
  }
  return finish(fallbackEntry(unit, ctx, cls.kind), "fallback");
}
