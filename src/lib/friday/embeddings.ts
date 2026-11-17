// Semantic skill matching + the memory index's embedder.
// Builds a persisted embedding index of all active skills once; per-task we embed the
// request and cosine-rank. Falls back to keyword scoring (skillMatch.ts) when no index
// exists or embeddings are unavailable — so it's a drop-in upgrade, never a hard dependency.
//
// 2026-10-28 (audit gap 8): LM Studio is retired, and the old default pointed every embed at it, so
// memory-reindex failed silently forever while reporting "up to date". There is NO implicit
// provider any more: embeddings are ON only when FRIDAY_EMBEDDINGS_URL names an OpenAI-compatible
// /v1 endpoint (+ FRIDAY_EMBEDDINGS_MODEL). Unset ⇒ embed() throws EmbeddingsDisabledError and the
// reindex job reports "disabled" with a warning instead of pretending to be current.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store } from "@/lib/persistence/store";
import { embed as sharedEmbed, cosine as sharedCosine } from "@autom8ionlab/agent-core";

const INDEX_FILE = path.join(FRIDAY_DATA_DIR, "skill-embeddings.json");

interface IndexEntry { id: string; vec: number[]; }
let memIndex: IndexEntry[] | null = null;

export class EmbeddingsDisabledError extends Error {
  constructor() {
    super("embeddings disabled — no provider configured (set FRIDAY_EMBEDDINGS_URL + FRIDAY_EMBEDDINGS_MODEL; LM Studio is retired)");
    this.name = "EmbeddingsDisabledError";
  }
}

/** The configured embedding endpoint, or null when embeddings are off. */
export function embeddingsProvider(): { baseUrl: string; model: string } | null {
  const baseUrl = (process.env.FRIDAY_EMBEDDINGS_URL ?? "").trim().replace(/\/$/, "");
  if (!baseUrl) return null;
  const model = (process.env.FRIDAY_EMBEDDINGS_MODEL ?? process.env.AGENTIC_OS_EMBED_MODEL ?? "").trim();
  if (!model) return null;
  return { baseUrl, model };
}

export async function embed(texts: string[]): Promise<number[][]> {
  const p = embeddingsProvider();
  if (!p) throw new EmbeddingsDisabledError();
  return sharedEmbed(texts, p);
}

export async function hasIndex(): Promise<boolean> {
  if (memIndex) return true;
  try { await fs.access(INDEX_FILE); return true; } catch { return false; }
}

// Build/refresh the skill embedding index (embeds name + description of every active skill).
export async function buildSkillIndex(): Promise<{ count: number }> {
  const skills = (await store.skills.all()).filter((s) => s.active);
  const texts = skills.map((s) => `${s.name}. ${s.description ?? ""}`);
  const vecs = await embed(texts);
  const index: IndexEntry[] = skills.map((s, i) => ({ id: s.id, vec: vecs[i] })).filter((e) => e.vec);
  await fs.writeFile(INDEX_FILE, JSON.stringify(index), "utf8");
  memIndex = index;
  return { count: index.length };
}

async function loadIndex(): Promise<IndexEntry[]> {
  if (memIndex) return memIndex;
  try { memIndex = JSON.parse(await fs.readFile(INDEX_FILE, "utf8")) as IndexEntry[]; } catch { memIndex = []; }
  return memIndex;
}

export const cosine = sharedCosine;

// Returns skill ids ranked by semantic similarity, or null if unavailable (→ caller falls
// back to keyword scoring).
export async function semanticSelectIds(taskText: string, limit: number, minScore = 0.35): Promise<string[] | null> {
  try {
    const index = await loadIndex();
    if (!index.length) return null;
    const [q] = await embed([taskText]);
    if (!q) return null;
    return index
      .map((e) => ({ id: e.id, score: cosine(q, e.vec) }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.id);
  } catch {
    return null;
  }
}
