// Build an agent's *effective* system prompt for a task: its own prompt (inline for
// builtins, lazy-loaded from `path` for imported agents) + pinned skills + auto-selected
// skills. This is what makes library skills usable from EVERY engine.
//
// Every engine gets the skill BODIES, packed under an engine-aware budget (skillBudget.ts).
// That includes Claude: FRIDAY spawns `claude` with `--setting-sources project,local`
// (runner.ts), which skips the user scope, so user-level skills are NOT auto-loaded in those
// runs, and a names-only hint would point at skills Claude can't see.
//
// Every call logs `skills.injected` (warn when a pinned id is missing from the index or a row's
// file can't be read) — the three ways skills used to vanish silently: a stale pin after a
// rescan, a moved file, and an argv budget that starved the pack.

import { store, logEvent } from "@/lib/persistence/store";
import { readBody } from "@/lib/friday/registry";
import { selectSkills } from "@/lib/friday/skillMatch";
import { packSkills, skillBudgetFor, PER_SKILL_CHARS } from "@/lib/friday/skillBudget";
import type { Agent, Skill } from "@/lib/friday/types";

const SKILLS_INTRO = "\n\n---\nYou also have these skills. Apply them where relevant:\n";

export async function buildSystemPrompt(agent: Agent, taskText: string): Promise<string> {
  // 1 — the agent's own prompt
  let base = agent.systemPrompt ?? "";
  if (!base && agent.path) base = await readBody(agent);

  // 2 — gather skills: manually pinned + auto-selected (deduped). Pinned go first: when the
  // budget can't fit everything, the tail (auto-picks) is listed by name instead of inlined.
  const pinnedIds = agent.skills ?? [];
  const pinned: Skill[] = [];
  for (const id of pinnedIds) {
    const s = await store.skills.get(id);
    if (s) pinned.push(s);
  }
  const missingPinned = pinnedIds.filter((id) => !pinned.some((s) => s.id === id));
  const auto = await selectSkills(taskText, { limit: 3 });
  const seen = new Set(pinned.map((s) => s.id));
  const autoPicked = auto.filter((s) => !seen.has(s.id));
  const skills = [...pinned, ...autoPicked];

  // 3 — pack under the engine's budget. Argv engines are capped so the prompt can never exceed
  // MAX_ARG_LEN (an over-long argv entry fails the run instead of being trimmed).
  const packable = await Promise.all(
    skills.map(async (s) => ({ id: s.id, name: s.name, body: (await readBody(s)) || s.description || "", description: s.description, path: s.path })),
  );
  const emptyBodies = packable.filter((p) => !p.body).map((p) => p.id);
  const budget = skills.length ? skillBudgetFor(agent.engine, base.length + SKILLS_INTRO.length + taskText.length) : 0;
  const packed = skills.length ? packSkills(packable, { total: budget, perSkill: PER_SKILL_CHARS }) : "";

  await logEvent(
    "skills.injected",
    {
      agentId: agent.id, engine: agent.engine,
      pinned: pinnedIds.length, resolvedPinned: pinned.map((s) => s.id), missingPinned, emptyBodies,
      auto: autoPicked.map((s) => s.id), chars: packed.length, budget,
    },
    { level: missingPinned.length || emptyBodies.length ? "warn" : "info" },
  ).catch(() => {});

  return packed ? `${base}${SKILLS_INTRO}${packed}` : base;
}
