// Relevance matching for skills + library agents.
//
// v1 uses fast, dependency-free token-overlap scoring against each record's description
// (skills carry rich "when to use…" descriptions, which makes this work well). A seam is
// left for an embedding upgrade (LM Studio's text-embedding-nomic-embed-text is loaded).

import { store } from "@/lib/persistence/store";
import { hasIndex, semanticSelectIds } from "@/lib/friday/embeddings";
import { allowedForBench } from "@/lib/friday/bench";
import type { Skill, Agent } from "@/lib/friday/types";

const STOP = new Set([
  "the","a","an","and","or","to","of","for","in","on","with","is","are","be","this","that","it",
  "you","your","when","user","wants","use","using","also","see","can","should","如果","请",
]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}

function score(queryTokens: Set<string>, text: string): number {
  const toks = tokens(text);
  if (!toks.length) return 0;
  let hits = 0;
  const seen = new Set<string>();
  for (const t of toks) {
    if (queryTokens.has(t) && !seen.has(t)) { hits++; seen.add(t); }
  }
  // Normalise a little by unique query coverage.
  return hits / Math.sqrt(queryTokens.size + 1);
}

export interface SkillMatch { skill: Skill; score: number; }

// Top-K skills relevant to a task. Only considers active skills.
export async function selectSkills(taskText: string, opts: { limit?: number; minScore?: number } = {}): Promise<Skill[]> {
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 1.0;

  // Prefer semantic (embedding) matching when an index has been built; else keyword.
  if (await hasIndex()) {
    const ids = await semanticSelectIds(taskText, limit);
    if (ids && ids.length) {
      const found = await Promise.all(ids.map((id) => store.skills.get(id)));
      return found.filter((s): s is Skill => !!s && s.active && allowedForBench(s));
    }
  }

  const q = new Set(tokens(taskText));
  if (!q.size) return [];
  const skills = (await store.skills.all()).filter((s) => s.active && allowedForBench(s));
  const scored: SkillMatch[] = skills.map((skill) => ({
    skill,
    score: score(q, `${skill.name} ${skill.description ?? ""} ${(skill.tags ?? []).join(" ")}`),
  }));
  return scored
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.skill);
}

// Best imported/library agent for a task (used when no active builtin fits). Only
// considers imported agents (source !== builtin) so FRIDAY can reach the whole library.
export async function findLibraryAgent(taskText: string, opts: { minScore?: number } = {}): Promise<Agent | null> {
  const minScore = opts.minScore ?? 1.5;
  const q = new Set(tokens(taskText));
  if (!q.size) return null;
  const agents = (await store.agents.all()).filter((a) => a.source !== "builtin" && allowedForBench(a));
  let best: { agent: Agent; score: number } | null = null;
  for (const agent of agents) {
    const s = score(q, `${agent.name} ${agent.description ?? ""} ${agent.type ?? ""} ${(agent.tools ?? []).join(" ")}`);
    if (!best || s > best.score) best = { agent, score: s };
  }
  return best && best.score >= minScore ? best.agent : null;
}
