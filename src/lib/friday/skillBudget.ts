// Pack skill bodies into a system prompt under a character budget. Pure (no I/O), so it's unit-tested
// in skillBudget.test.ts.
//
// Replaces one shared 6000-char budget consumed in order, where the first 6-9KB skill was cut and every
// skill after it got nothing. Now:
//   - every inlined skill gets a fair share; room a short skill doesn't need flows to the longer ones;
//   - a truncated skill ends with a pointer to its full file (Claude/Codex can read the rest);
//   - skills that can't get a useful slice are listed by name + path instead of silently dropped;
//   - input order is priority: callers pass pinned skills first, so auto-picks are listed first.

import { MAX_ARG_LEN } from "@autom8ionlab/agent-core";

export interface PackableSkill { name: string; body: string; description?: string; path?: string }
export interface PackOptions { total: number; perSkill: number }

export const PER_SKILL_CHARS = 9_000;
// Codex reads its prompt from stdin, so it has no argv cap.
const STDIN_BUDGET = 40_000;
// Claude (--append-system-prompt) and Antigravity (-p) take the prompt as ONE argv entry, and an entry
// longer than MAX_ARG_LEN fails the whole run — so their budget is also bounded by what's left.
const ARGV_BUDGET = 24_000;
// Slack for the task text Antigravity appends to the same argv entry, plus headroom.
const ARGV_RESERVE = 4_000;
const STDIN_ENGINES = new Set(["codex"]);
const MIN_SLICE = 400; // a body slice shorter than this is noise — list the skill instead

function envBudget(engine: string): number | null {
  const v = Number(process.env[`AGENTIC_OS_SKILL_BUDGET_${engine.toUpperCase()}`]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Total skill-text budget for an engine, given the length of everything else in the prompt. */
export function skillBudgetFor(engine: string, otherLen: number): number {
  if (STDIN_ENGINES.has(engine)) return envBudget(engine) ?? STDIN_BUDGET;
  const ceiling = MAX_ARG_LEN - otherLen - ARGV_RESERVE;
  return Math.max(0, Math.min(envBudget(engine) ?? ARGV_BUDGET, ceiling));
}

/** Cut to at most `max` chars without splitting a UTF-16 surrogate pair. */
export function truncateSafe(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

const LIST_HEAD = "\n## Also available (not inlined — read the file when relevant):\n";
const header = (s: PackableSkill) => `\n## Skill: ${s.name}\n`;
const marker = (s: PackableSkill) => (s.path ? `\n… (truncated — full skill: ${s.path})` : "\n… (truncated)");
const overhead = (s: PackableSkill) => header(s).length + marker(s).length + 1;
const listLine = (s: PackableSkill) =>
  `- ${s.name}${s.description ? ` — ${truncateSafe(s.description.replace(/\s+/g, " ").trim(), 160)}` : ""}${s.path ? ` (${s.path})` : ""}\n`;
const listing = (rest: PackableSkill[]) => (rest.length ? LIST_HEAD + rest.map(listLine).join("") : "");

// Keep whole lines of a listing that fit in `max` chars (a half-line is worse than none).
function fitLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 1);
  return cut > LIST_HEAD.length ? text.slice(0, cut + 1) : "";
}

export function packSkills(skills: PackableSkill[], opts: PackOptions): string {
  const total = Math.max(0, Math.floor(opts.total));
  if (!skills.length || total === 0) return "";

  // How many (from the front) can be inlined with a useful slice each, after reserving room to list the rest.
  let k = skills.length;
  let listed = "";
  for (;;) {
    listed = listing(skills.slice(k));
    const need = skills.slice(0, k).reduce((n, s) => n + overhead(s) + Math.min(s.body.length, MIN_SLICE), 0);
    if (need + listed.length <= total || k === 0) break;
    k--;
  }
  if (k === 0) return fitLines(listed, total);

  // Water-fill the remaining room across the inlined skills, smallest need first, so short skills stay
  // whole and whatever they leave over goes to the longer ones.
  const inline = skills.slice(0, k);
  const want = inline.map((s) => Math.min(s.body.length, opts.perSkill));
  const alloc = new Array<number>(inline.length).fill(0);
  let room = total - listed.length;
  let left = inline.length;
  for (const i of inline.map((_, i) => i).sort((a, b) => want[a] - want[b])) {
    const oh = overhead(inline[i]);
    const share = Math.floor(room / left) - oh;
    left--;
    if (share <= 0) continue;
    alloc[i] = Math.min(want[i], share);
    room -= alloc[i] + oh;
  }

  const blocks = inline
    .map((s, i) => {
      if (alloc[i] <= 0) return "";
      const body = truncateSafe(s.body, alloc[i]);
      return header(s) + body + (body.length < s.body.length ? marker(s) : "") + "\n";
    })
    .join("");
  // A skill that ended up with no slice is listed rather than dropped, if a line still fits.
  const starved = inline.filter((_, i) => alloc[i] <= 0);
  let extra = "";
  if (starved.length) {
    const head = listed ? "" : LIST_HEAD;
    extra = fitLines(head + starved.map(listLine).join(""), Math.max(0, room));
  }
  return blocks + listed + extra;
}
