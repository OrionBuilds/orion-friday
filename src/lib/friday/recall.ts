// FRIDAY — cross-session recall. messages.jsonl already remembers every owner/client exchange;
// this makes it FINDABLE. A per-agent SQLite store (agent-core/sessionstore, ported from Hermes
// Agent's FTS5 design) indexes each message as it lands, and the recall_sessions intent tool
// searches it — "what did we decide about the staging rollout" has a real answer months later.
//
// The hook is RecallingStream below: persistence/store.ts constructs `store.messages` with it,
// so every append across the orchestrator/ownerChat/clientChannel call sites mirrors into the
// index from ONE place instead of eleven. FRIDAY's db is hers alone, under FRIDAY_DATA_DIR —
// CLARA keeps its own; recall never leaks (or write-contends) across agents.

import path from "node:path";
import {
  Stream, openSessionStore, formatRecallMatches,
  type SessionStore, type RecallMatch,
} from "@autom8ionlab/agent-core";
import type { Message } from "@/lib/friday/types";

const AGENT = "friday";

let storePromise: Promise<SessionStore | null> | null = null;

// Open once per process; the first open also backfills messages.jsonl. Cheap to repeat — the
// store keeps a byte offset per file, so after the true first run it's a stat plus whatever
// tail appended since (content-hash dedupe catches anything the offset misses).
//
// The data dir comes via dynamic import: persistence/store.ts statically imports THIS module
// (for RecallingStream), so a static import back would be a cycle.
async function open(): Promise<SessionStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const { FRIDAY_DATA_DIR } = await import("@/lib/persistence/store");
        const store = await openSessionStore(path.join(FRIDAY_DATA_DIR, "recall.db"));
        await store.indexJsonl(path.join(FRIDAY_DATA_DIR, "messages.jsonl"), { agent: AGENT }).catch(() => {});
        return store;
      } catch {
        return null; // recall is an enhancement — a broken db must never take chat down
      }
    })();
  }
  return storePromise;
}

/** Best-effort by contract: rides the message-append hot path, so it never throws and the
 *  append never waits on it. Same fields as the JSONL row → same dedupe hash a backfill computes. */
async function recordRecall(row: Pick<Message, "ts" | "role" | "text" | "channel">): Promise<void> {
  try {
    const store = await open();
    store?.record({ agent: AGENT, channel: row.channel, role: row.role, content: row.text, at: row.ts });
  } catch {
    /* never surface */
  }
}

/** The messages Stream with recall mirroring — drop-in for `new Stream<Message>(...)`. */
export class RecallingStream extends Stream<Message> {
  async append(row: Message): Promise<Message> {
    const out = await super.append(row);
    void recordRecall(row);
    return out;
  }
}

/** Search past sessions, formatted for the model: "[date · title] (role) snippet" per hit. */
export async function searchRecall(query: string, limit = 8): Promise<string> {
  const store = await open();
  if (!store) return "Recall store unavailable.";
  let hits: RecallMatch[];
  try {
    hits = store.search({ query, agent: AGENT, limit });
  } catch {
    return "Recall store unavailable.";
  }
  return formatRecallMatches(hits);
}
