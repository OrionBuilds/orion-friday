// FRIDAY institutional memory — a retrieval layer over everything already persisted (client
// messages, agent-run deliverables, meeting transcripts). FRIDAY embeds each item once (the
// FRIDAY_EMBEDDINGS_URL provider, same pipeline as skill matching; LM Studio is retired and is no
// longer an implicit default) into a local vector index, then recalls the most
// relevant snippets — scoped to a client or project — to ground her replies instead of starting cold.
//
// Reuses `embed()` + `cosine()` from embeddings.ts. Separate index file from the skill index. Every
// entry point is best-effort: if LM Studio / the embed model is unavailable, indexing is skipped and
// recall returns [] — prompts still build, nothing breaks.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store } from "@/lib/persistence/store";
import { embed, cosine, embeddingsProvider } from "@/lib/friday/embeddings";
import type { Project } from "@/lib/friday/types";

const INDEX_FILE = path.join(FRIDAY_DATA_DIR, "memory-embeddings.json");
const MEMORY_OFF = () => process.env.AGENTIC_OS_MEMORY === "off";

export type MemoryKind = "message" | "run" | "transcript" | "event" | "note" | "doc";

export interface MemoryItem {
  id: string;                    // stable per source row: `msg:<id>`, `run:<id>`, `meet:<id>`, …
  kind: MemoryKind;
  text: string;                  // the text to embed (truncated by embed() to ~2000 chars)
  clientId?: string;
  projectId?: string;
  ts: string;                    // ISO — for recency + the recall label
  ref?: string;                  // optional provenance (e.g. a URL)
}

interface IndexEntry {
  id: string; kind: MemoryKind; snippet: string;
  clientId?: string; projectId?: string; ts: string; ref?: string;
  vec: number[];
}

let memIndex: IndexEntry[] | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function loadIndex(): Promise<IndexEntry[]> {
  if (memIndex) return memIndex;
  try { memIndex = JSON.parse(await fs.readFile(INDEX_FILE, "utf8")) as IndexEntry[]; } catch { memIndex = []; }
  return memIndex;
}

// Serialize writes so concurrent indexMemory / reindex calls can't clobber the file.
function persist(rows: IndexEntry[]): Promise<void> {
  memIndex = rows;
  const next = writeChain.catch(() => {}).then(() => fs.writeFile(INDEX_FILE, JSON.stringify(rows), "utf8"));
  writeChain = next.catch(() => {});
  return next;
}

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

// Map a projectId → its clientId (so client-scoped recall works even though Message/AgentRun carry
// no clientId). Cached per call-site via the passed map.
function clientOf(projectId: string | undefined, projById: Map<string, Project>): string | undefined {
  return projectId ? projById.get(projectId)?.clientId : undefined;
}

async function projectMap(): Promise<Map<string, Project>> {
  const projects = await store.projects.all();
  return new Map(projects.map((p) => [p.id, p]));
}

// Index a single item (upsert by id). Best-effort + non-blocking-friendly (callers should not await
// on the hot path if they don't need to).
export async function indexMemory(item: MemoryItem): Promise<void> {
  if (MEMORY_OFF()) return;
  const text = item.text?.trim();
  if (!text || text.length < 12) return;
  try {
    const index = await loadIndex();
    if (index.some((e) => e.id === item.id)) return; // already indexed — cheap dedupe
    const [vec] = await embed([text]);
    if (!vec) return;
    index.push({ id: item.id, kind: item.kind, snippet: snippetOf(text), clientId: item.clientId, projectId: item.projectId, ts: item.ts, ref: item.ref, vec });
    await persist(index);
  } catch { /* embeddings unavailable — skip, recall degrades gracefully */ }
}

/**
 * Remove every index entry whose id starts with `idPrefix` (e.g. `doc:<docId>#` when a client doc is
 * deleted or re-indexed). Deliberately NOT gated by AGENTIC_OS_MEMORY — deleting a doc must clean its
 * chunks even while indexing is switched off. Empty prefix is refused (it would wipe the index).
 */
export async function removeMemory(idPrefix: string): Promise<number> {
  if (!idPrefix) return 0;
  try {
    const index = await loadIndex();
    const keep = index.filter((e) => !e.id.startsWith(idPrefix));
    const removed = index.length - keep.length;
    if (removed) await persist(keep);
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Index many items with ONE embed call and ONE index write — a 40-chunk document must not mean 40
 * HTTP round-trips and 40 full-file rewrites. Same dedupe-by-id and best-effort posture as
 * indexMemory. Returns how many entries were actually added.
 */
export async function indexMemoryBatch(items: MemoryItem[]): Promise<number> {
  if (MEMORY_OFF()) return 0;
  try {
    const index = await loadIndex();
    const have = new Set(index.map((e) => e.id));
    const pending = items.filter((it) => it.text?.trim() && it.text.trim().length >= 12 && !have.has(it.id));
    if (!pending.length) return 0;
    const vecs = await embed(pending.map((p) => p.text.trim()));
    let added = 0;
    for (let i = 0; i < pending.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      const p = pending[i];
      index.push({ id: p.id, kind: p.kind, snippet: snippetOf(p.text), clientId: p.clientId, projectId: p.projectId, ts: p.ts, ref: p.ref, vec: v });
      added++;
    }
    if (added) await persist(index);
    return added;
  } catch {
    return 0; // embeddings unavailable — recall degrades gracefully
  }
}

export interface Recall { id: string; kind: MemoryKind; snippet: string; ts: string; ref?: string; score: number }

// Retrieve the most relevant remembered snippets for a query, hard-scoped to a client/project.
// clientId scoping is a HARD filter — recall must never surface one client's memory to another.
export async function recallMemory(
  query: string,
  opts: { clientId?: string; projectId?: string; limit?: number; minScore?: number } = {},
): Promise<Recall[]> {
  if (MEMORY_OFF()) return [];
  const { clientId, projectId, limit = 5, minScore = 0.42 } = opts;
  try {
    const index = await loadIndex();
    if (!index.length || !query.trim()) return [];
    const scoped = index.filter((e) =>
      (clientId ? e.clientId === clientId : true) &&
      (projectId ? e.projectId === projectId : true));
    if (!scoped.length) return [];
    const [q] = await embed([query]);
    if (!q) return [];
    return scoped
      .map((e) => ({ id: e.id, kind: e.kind, snippet: e.snippet, ts: e.ts, ref: e.ref, score: cosine(q, e.vec) }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch { return []; }
}

// List everything FRIDAY remembers about a client, most-recent first — no query/embedding needed
// (pure index filter). Powers the per-client "What FRIDAY remembers" panel.
export async function listClientMemory(clientId: string, limit = 20): Promise<Recall[]> {
  if (MEMORY_OFF() || !clientId) return [];
  try {
    const index = await loadIndex();
    return index
      .filter((e) => e.clientId === clientId)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, limit)
      .map((e) => ({ id: e.id, kind: e.kind, snippet: e.snippet, ts: e.ts, ref: e.ref, score: 1 }));
  } catch { return []; }
}

const KIND_LABEL: Record<MemoryKind, string> = { message: "Past note", run: "Past deliverable", transcript: "From a call", event: "Past request", note: "Note", doc: "Client doc" };

function shortDate(ts: string): string {
  try { return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; }
}

// A ready-to-inject prompt block ("" when nothing relevant), for the client/planner/task seams.
export async function recallBlock(
  query: string,
  opts: { clientId?: string; projectId?: string; limit?: number; minScore?: number },
  header = "Relevant history you remember (use it to sound informed; don't quote it verbatim)",
): Promise<string> {
  const hits = await recallMemory(query, opts);
  if (!hits.length) return "";
  const lines = hits.map((h) => `- [${KIND_LABEL[h.kind]}${h.ts ? ` · ${shortDate(h.ts)}` : ""}] ${h.snippet}`);
  return `\n\n${header}:\n${lines.join("\n")}`;
}

// ── Backfill / catch-up ────────────────────────────────────────────────────
// Walk the persisted messages + runs and embed anything not already indexed. Idempotent (dedupes by
// id), batched for efficiency, safe to run repeatedly (scheduler heartbeat + on-demand).
//
// 2026-10-28 (audit gap 8): no provider ⇒ `{disabled:true}` (the job reports it, with a warning);
// an embed FAILURE now throws instead of being swallowed into a fake "up to date".
export async function reindexMemory(opts: { max?: number } = {}): Promise<{ indexed: number; total: number; pending?: number; disabled?: boolean }> {
  if (MEMORY_OFF()) return { indexed: 0, total: 0 };
  if (!embeddingsProvider()) return { indexed: 0, total: 0, disabled: true };
  const max = opts.max ?? 400;
  const index = await loadIndex();
  const have = new Set(index.map((e) => e.id));
  const projById = await projectMap();
  const pending: MemoryItem[] = [];

  // Client + owner conversation.
  for (const m of await store.messages.tail(2000)) {
    const id = `msg:${m.id}`;
    if (have.has(id)) continue;
    if (m.role !== "user" && m.role !== "friday") continue;
    if (!m.text || m.text.trim().length < 12) continue;
    pending.push({ id, kind: "message", text: m.text, projectId: m.projectId, clientId: clientOf(m.projectId, projById), ts: m.ts });
    if (pending.length >= max) break;
  }

  // Agent-run deliverables (summary + result).
  if (pending.length < max) {
    for (const r of await store.runs.all()) {
      const id = `run:${r.id}`;
      if (have.has(id)) continue;
      if (r.status !== "done") continue;
      const text = [r.summary, r.result].filter(Boolean).join("\n").slice(0, 1900);
      if (!text || text.trim().length < 12) continue;
      pending.push({ id, kind: "run", text, projectId: r.projectId, clientId: clientOf(r.projectId, projById), ts: r.endedAt ?? r.startedAt });
      if (pending.length >= max) break;
    }
  }

  if (!pending.length) return { indexed: 0, total: index.length };

  // Batch-embed for efficiency, then append everything in one write.
  let indexed = 0;
  let vecs: number[][];
  try {
    vecs = await embed(pending.map((p) => p.text));
  } catch (e) {
    // Surface it: the scheduler logs a failed job and backs off. Swallowing this is how the index
    // sat stale for weeks behind a retired LM Studio while the job said "up to date".
    throw new Error(`memory reindex: embedding ${pending.length} item(s) failed — ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  for (let i = 0; i < pending.length; i++) {
    const v = vecs[i]; if (!v) continue;
    const p = pending[i];
    index.push({ id: p.id, kind: p.kind, snippet: snippetOf(p.text), clientId: p.clientId, projectId: p.projectId, ts: p.ts, ref: p.ref, vec: v });
    indexed++;
  }
  if (indexed) await persist(index);
  return { indexed, total: index.length, pending: pending.length };
}

// Resolve a projectId → clientId once (for capture-site callers that have only a projectId).
export async function clientIdForProject(projectId?: string): Promise<string | undefined> {
  if (!projectId) return undefined;
  try { return (await store.projects.get(projectId))?.clientId; } catch { return undefined; }
}
