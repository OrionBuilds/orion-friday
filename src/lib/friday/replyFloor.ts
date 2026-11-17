// FRIDAY's reply floor — the hard line between "read for context" and "answer".
//
// She may READ up to `config.email.contextDays` back to understand an ongoing thread. She may only
// REPLY to mail at or after this floor. Nothing older is ever answered, whatever the seen-set says.
//
// Why a floor at all, when the seen-set already dedupes: the two fail in opposite directions. A lost
// or evicted seen-set fails OPEN — every unread mail in the rolling window becomes answerable again,
// which is how 23 stale messages once got auto-replied. A lost anchor fails CLOSED: it re-anchors to
// now, which is strictly more restrictive. The floor is the only gate whose failure mode is safe.
//
// In steady state this is a no-op — once the anchor is older than contextDays the search window
// dominates. It is a tripwire for re-ingest events (activation, seen-set loss, disaster recovery),
// not a daily filter. Don't "optimize" it away on the grounds that it never fires.
//
// The floor is an INSTANT, not a calendar day, so timezones never enter the picture: instants don't
// have one. A human does the "midnight Eastern" arithmetic once when setting the anchor; no code here
// ever computes a zone. (This is also why FRIDAY's total lack of TZ config doesn't matter.)

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";
import { config } from "@/lib/config";

const FLOOR_FILE = path.join(FRIDAY_DATA_DIR, "reply-floor.json");

interface FloorFile {
  activatedAt: number; // epoch ms
  writtenAt: string;
  note: string;
}

export interface Floor {
  ms: number;
  iso: string;
  source: "env" | "config" | "anchor" | "fallback";
}

// Cached for the process: a deleted file can't move the floor mid-poll, and the value is stable
// across a single tick. Changing the env var needs a restart — acceptable for a safety anchor.
let cached: Floor | null = null;

/** ISO-8601 or epoch-ms → epoch ms. Returns null for anything we can't trust. */
function parseInstant(v: string | null | undefined): number | null {
  const s = v?.trim();
  if (!s) return null;
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Is this message new enough to answer?
 *
 * MUST be an affirmative finite test. The obvious `internalDate < floorMs` FAILS OPEN: `undefined`
 * and `NaN` comparisons are always false, so a missing field would skip nothing and let the whole
 * backlog through — precisely under the conditions this guard exists for.
 */
export function repliableAt(internalDate: unknown, floorMs: number): boolean {
  const ts = Number(internalDate);
  return Number.isFinite(ts) && ts > 0 && ts >= floorMs;
}

/** Set FRIDAY_EMAIL_REPLY_FLOOR_ENFORCE=0 to resolve + log the floor without actually gating. */
export function floorEnforced(): boolean {
  return process.env.FRIDAY_EMAIL_REPLY_FLOOR_ENFORCE !== "0";
}

export async function replyFloor(): Promise<Floor> {
  if (cached) return cached;

  // 1. The persisted anchor. Read/create it FIRST, even when an override is set, so that removing
  //    the override later falls back to the original activation instant rather than re-anchoring
  //    to now (which would silently expose everything between activation and the removal).
  let anchor: number | null = null;
  try {
    const j = JSON.parse(await fs.readFile(FLOOR_FILE, "utf8")) as FloorFile;
    anchor = Number.isFinite(j.activatedAt) ? j.activatedAt : null;
  } catch {
    /* missing or corrupt → re-anchor forward, the safe direction */
  }

  if (anchor == null) {
    anchor = Date.now();
    const body: FloorFile = {
      activatedAt: anchor,
      writtenAt: new Date().toISOString(),
      note: "FRIDAY never replies to inbound mail older than activatedAt. Delete this file only if you intend her to re-anchor to now.",
    };
    try {
      await fs.writeFile(FLOOR_FILE, JSON.stringify(body, null, 2), "utf8");
      await logEvent("email.floor.initialized", { floorISO: new Date(anchor).toISOString() }, { level: "warn" });
    } catch (e) {
      // Can't persist → hold it for THIS process only; we re-anchor on every restart. Still fails
      // closed, but it degrades silently, so make noise.
      await logEvent("email.floor.persist_failed", { error: String(e).slice(0, 200) }, { level: "error" }).catch(() => {});
      cached = { ms: anchor, iso: new Date(anchor).toISOString(), source: "fallback" };
      return cached;
    }
  }

  // 2. Overrides: env > file config > anchor.
  const envMs = parseInstant(process.env.FRIDAY_EMAIL_REPLY_FLOOR);
  const cfgMs = parseInstant(config.email?.replyFloor);
  const source: Floor["source"] = envMs != null ? "env" : cfgMs != null ? "config" : "anchor";
  const ms = envMs ?? cfgMs ?? anchor;

  if (ms < anchor) {
    // Deliberately exposing backlog that activation had sealed off. Legitimate, but never silent.
    await logEvent(
      "email.floor.override_backwards",
      { floorISO: new Date(ms).toISOString(), anchorISO: new Date(anchor).toISOString(), source },
      { level: "warn" },
    ).catch(() => {});
  }

  cached = { ms, iso: new Date(ms).toISOString(), source };
  return cached;
}
