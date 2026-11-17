// FRIDAY — weekly skills.sh self-improvement loop (owner 2026-10-23).
//
// "Periodically search skills.sh for new skills she can adopt for Clara/the sub-agents — an ever
// self-improving system." Owner decisions: AUTO-adopt Official/audited skills only; PROPOSE the rest
// for approval; weekly cadence; browser-driven via her own agy (Antigravity) browser agent.
//
// SAFETY: a skill is just markdown instructions (SKILL.md), and skills.sh renders its catalog to an
// anonymous browser — so adoption here is "agy reads the page, FRIDAY writes the SKILL.md into a
// scanned skills dir". NO `npx skills add`, NO install-time code execution, NO Vercel API token. The
// registry (registry-scan, every 30 min) then indexes the file so skillMatch can inject it into
// sub-agent runs. A skill's own scripts, if any, would only run inside a later (sandboxed) agent task.
//
// Kill switch: FRIDAY_SKILLS_DISCOVERY=off.
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { run } from "@/lib/runner";
import { logEvent } from "@/lib/persistence/store";

// Where adopted skills land — a dedicated scanned source (added to config.registrySources, or this
// default which registry.importSources picks up if present). `*/SKILL.md` glob: one dir per skill.
export const ADOPTED_SKILLS_ROOT = path.join(os.homedir(), ".agentic-os", "skills-sh", ".claude", "skills");
const STATE_FILE = path.join(os.homedir(), ".agentic-os", "friday", "skills-sh-state.json");

// Topics FRIDAY's own work (coding, review, QA, browser, comms) benefits from — steers the search.
const TOPICS = ["code review", "debugging", "testing", "browser automation", "git", "pull request", "refactoring", "email", "calendar", "research", "documentation"];
const MAX_CANDIDATES = 12;
const MAX_AUTO_ADOPT = 6;

export interface SkillCandidate {
  name: string;
  source: string;        // owner/repo
  slug: string;          // url-safe id within the repo
  installs?: string;
  official?: boolean;    // from skills.sh /official
  audited?: boolean;     // has a passing security audit
  auditStatus?: string;  // pass | warn | fail | none
  relevance?: number;    // 1-5, how useful for FRIDAY/sub-agents/Clara
  whatFor?: string;      // "friday" | "subagent" | "clara"
  summary?: string;
}

interface State { adopted: Record<string, string>; rejected: string[]; seen: string[] }

export function skillsDiscoveryEnabled(): boolean {
  return (process.env.FRIDAY_SKILLS_DISCOVERY ?? "on").trim().toLowerCase() !== "off";
}

async function readState(): Promise<State> {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, "utf8")) as State; }
  catch { return { adopted: {}, rejected: [], seen: [] }; }
}
async function writeState(s: State): Promise<void> {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true }).catch(() => {});
  await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Parse a JSON array out of an agy `response` string (tolerates a stray fence or prose). */
export function parseJsonArray<T = unknown>(text: string): T[] {
  const t = (text ?? "").trim();
  try { const d = JSON.parse(t); return Array.isArray(d) ? d : []; } catch { /* fall through */ }
  const m = t.match(/\[[\s\S]*\]/);
  if (m) { try { const d = JSON.parse(m[0]); return Array.isArray(d) ? d : []; } catch { /* nope */ } }
  return [];
}

/** One agy browser turn → its final text (SUCCESS only), or throws. */
async function agy(prompt: string, timeoutMs = 240_000): Promise<string> {
  const result = await run("antigravity", [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--output-format", "json",
    "--print-timeout", `${Math.max(60, Math.floor(timeoutMs / 1000))}s`,
  ], { timeoutMs: timeoutMs + 30_000 });
  let text = (result.stdout || "").trim();
  try {
    const j = JSON.parse(result.stdout) as { status?: string; response?: string; error?: string };
    if (j.status && j.status !== "SUCCESS") throw new Error(`agy ${j.status}: ${String(j.error ?? "").slice(0, 200)}`);
    text = (j.response ?? "").trim();
  } catch (e) { if (!result.ok) throw e; }
  if (!result.ok) throw new Error(`agy failed (code ${result.code}): ${(result.stderr || result.stdout).slice(0, 200)}`);
  return text;
}

/** Phase 1 — agy browses skills.sh and returns ranked candidates (no SKILL.md yet). */
export async function discoverCandidates(): Promise<SkillCandidate[]> {
  const prompt = [
    "You are FRIDAY's skill scout. Open https://skills.sh in your browser and let it render.",
    `Find agent skills that would genuinely improve a software-engineering + ops assistant and its sub-agents (coding, code review, QA/debugging, git/PRs, browser automation, email, calendar, research). Look at the Trending and Hot leaderboards, the Official page (https://skills.sh/official), and search for these topics: ${TOPICS.join(", ")}.`,
    `Return ONLY a JSON array (no prose, no code fence) of up to ${MAX_CANDIDATES} of the MOST useful, each:`,
    `{"name":"", "source":"owner/repo", "slug":"url-safe skill id", "installs":"", "official": true/false (is it listed on /official?), "audited": true/false (does it have a passing security audit — a ✓/verified badge?), "auditStatus":"pass|warn|fail|none", "relevance": 1-5 (how useful for this assistant), "whatFor":"friday|subagent|clara", "summary":"one line on what it does"}`,
    "Prefer Official and audited skills. Skip anything unrelated (marketing, games, unrelated products).",
  ].join("\n");
  const cands = parseJsonArray<SkillCandidate>(await agy(prompt));
  return cands.filter((c) => c && c.source && c.slug).slice(0, MAX_CANDIDATES);
}

/** Phase 2 — agy fetches the SKILL.md body for the chosen skills from their skills.sh pages. */
export async function fetchSkillBodies(skills: SkillCandidate[]): Promise<Record<string, string>> {
  if (!skills.length) return {};
  const list = skills.map((s) => `- https://skills.sh/${s.source}/${s.slug}  (key: ${s.source}/${s.slug})`).join("\n");
  const prompt = [
    "Open each of these skill pages on skills.sh and read the full SKILL.md shown on the page.",
    list,
    'Return ONLY a JSON array (no prose/fence): [{"key":"owner/repo/slug", "skillMd":"<the complete SKILL.md markdown, verbatim>"}]. If a page has no SKILL.md, omit it.',
  ].join("\n");
  const rows = parseJsonArray<{ key: string; skillMd: string }>(await agy(prompt, 300_000));
  const out: Record<string, string> = {};
  for (const r of rows) if (r?.key && r.skillMd && r.skillMd.trim().length > 40) out[r.key] = r.skillMd;
  return out;
}

const idOf = (c: Pick<SkillCandidate, "source" | "slug">) => `${c.source}/${c.slug}`;

/** Auto-adopt rule (owner): Official OR audited-pass, and clearly relevant. */
export function isAutoAdoptable(c: SkillCandidate): boolean {
  const relevant = (c.relevance ?? 0) >= 4;
  const safe = c.official === true || c.audited === true || (c.auditStatus ?? "").toLowerCase() === "pass";
  return relevant && safe;
}

/** Write a skill's SKILL.md into the adopted-skills source dir so the registry indexes it. */
export async function adoptSkill(c: SkillCandidate, skillMd: string): Promise<string> {
  const safeSlug = c.slug.replace(/[^a-z0-9._-]/gi, "-").slice(0, 80) || "skill";
  const dir = path.join(ADOPTED_SKILLS_ROOT, safeSlug);
  await fsp.mkdir(dir, { recursive: true });
  const header = `<!-- adopted from https://skills.sh/${c.source}/${c.slug} on ${new Date().toISOString()} (installs ${c.installs ?? "?"}, official=${!!c.official}, audit=${c.auditStatus ?? "?"}) -->\n`;
  await fsp.writeFile(path.join(dir, "SKILL.md"), header + skillMd.trim() + "\n", "utf8");
  return dir;
}

export interface DiscoveryResult { adopted: SkillCandidate[]; proposed: SkillCandidate[]; skipped: number; error?: string }

/** The weekly job: discover → auto-adopt Official/audited → surface the rest for owner approval. */
export async function runSkillsDiscovery(deps?: {
  discover?: typeof discoverCandidates; fetchBodies?: typeof fetchSkillBodies; adopt?: typeof adoptSkill;
  notifyOwner?: (summary: string, detail: string) => Promise<void>;
}): Promise<DiscoveryResult> {
  if (!skillsDiscoveryEnabled()) return { adopted: [], proposed: [], skipped: 0, error: "disabled" };
  const discover = deps?.discover ?? discoverCandidates;
  const fetchBodies = deps?.fetchBodies ?? fetchSkillBodies;
  const adopt = deps?.adopt ?? adoptSkill;

  const state = await readState();
  const known = new Set([...Object.keys(state.adopted), ...state.rejected, ...state.seen]);

  let candidates: SkillCandidate[];
  try { candidates = await discover(); }
  catch (e) { await logEvent("skills.discovery.error", { error: String(e).slice(0, 300) }, { level: "warn" }); return { adopted: [], proposed: [], skipped: 0, error: String(e).slice(0, 200) }; }

  const fresh = candidates.filter((c) => !known.has(idOf(c)));
  const skipped = candidates.length - fresh.length;
  const toAdopt = fresh.filter(isAutoAdoptable).slice(0, MAX_AUTO_ADOPT);
  const toPropose = fresh.filter((c) => !isAutoAdoptable(c) && (c.relevance ?? 0) >= 3);

  const bodies = await fetchBodies(toAdopt).catch(() => ({} as Record<string, string>));
  const adopted: SkillCandidate[] = [];
  for (const c of toAdopt) {
    const md = bodies[idOf(c)];
    if (!md) continue; // couldn't fetch the body — leave it for next week
    try { await adopt(c, md); state.adopted[idOf(c)] = new Date().toISOString(); adopted.push(c); }
    catch (e) { await logEvent("skills.adopt.error", { id: idOf(c), error: String(e).slice(0, 200) }, { level: "warn" }); }
  }
  for (const c of fresh) if (!state.seen.includes(idOf(c))) state.seen.push(idOf(c));
  state.seen = state.seen.slice(-500);
  await writeState(state);

  await logEvent("skills.discovery", { candidates: candidates.length, fresh: fresh.length, adopted: adopted.length, proposed: toPropose.length, skipped });

  // Report: what was auto-adopted + what's waiting for the owner's go.
  if ((adopted.length || toPropose.length) && deps?.notifyOwner) {
    const lines: string[] = [];
    if (adopted.length) lines.push(`Adopted ${adopted.length} skill${adopted.length === 1 ? "" : "s"} (Official/audited): ${adopted.map((c) => c.name).join(", ")}.`);
    if (toPropose.length) lines.push(`${toPropose.length} more to approve: ${toPropose.slice(0, 6).map((c) => `${c.name} (${c.source})`).join("; ")}. Tell me to adopt any by name.`);
    await deps.notifyOwner(`Skills check: +${adopted.length} adopted, ${toPropose.length} to review`, lines.join("\n")).catch(() => {});
  }
  return { adopted, proposed: toPropose, skipped };
}
