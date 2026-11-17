// FRIDAY — meeting offers with concrete slots (owner ask 2026-07-19: "can we hop on a call?" should
// get real times, not a bounce to the owner).
//
// Flow: a client asks to talk → the reply carries 2-3 concrete free slots (client's timezone) — and
// because offering a time IS a commitment, that reply always rides the approve-to-send loop today
// (the owner reads it before it goes; a `meeting_offer` authority class exists for a future auto tier).
// The client answers "option 2" → a DETERMINISTIC matcher (never the LLM) confirms it: free/busy is
// re-checked at confirm time, the Meet event is created with both parties invited (Google sends the
// invites), and the confirmation reply is routine. Anything ambiguous falls through to the normal
// reply pipeline, which simply asks them to pick — it never guesses a booking.
//
// Offers live in meeting-offers.json with a 72h expiry, pruned at every load — a stale "option 1"
// months later can never book anything. Kill switch FRIDAY_MEETING_OFFER=off.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, newId, logEvent } from "@/lib/persistence/store";
import type { Client } from "@/lib/friday/types";
import { AGENCY } from "@/lib/friday/persona";

export function meetingOfferEnabled(): boolean {
  return (process.env.FRIDAY_MEETING_OFFER ?? "on").trim().toLowerCase() !== "off";
}

export const SLOT_MINUTES = 30;
export const OFFER_TTL_MS = 72 * 3_600_000;
const MIN_LEAD_MS = 3 * 3_600_000; // never offer a slot less than 3h out

export interface OfferSlot { startISO: string; endISO: string; label: string }
export interface MeetingOffer {
  id: string;
  clientId: string;
  slots: OfferSlot[];
  createdAt: number;
  expiresAt: number;
}

const OFFERS_FILE = path.join(FRIDAY_DATA_DIR, "meeting-offers.json");

async function loadOffers(): Promise<MeetingOffer[]> {
  try {
    const rows = JSON.parse(await fs.readFile(OFFERS_FILE, "utf8")) as MeetingOffer[];
    return rows.filter((r) => r.expiresAt > Date.now());
  } catch {
    return [];
  }
}
async function saveOffers(rows: MeetingOffer[]): Promise<void> {
  try { await fs.writeFile(OFFERS_FILE, JSON.stringify(rows.filter((r) => r.expiresAt > Date.now()))); } catch { /* best-effort */ }
}

export async function pendingOfferFor(clientId: string): Promise<MeetingOffer | null> {
  const rows = await loadOffers();
  return rows.filter((r) => r.clientId === clientId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export async function consumeOffer(id: string): Promise<void> {
  await saveOffers((await loadOffers()).filter((r) => r.id !== id));
}

function slotLabel(startISO: string, tz: string): string {
  const d = new Date(startISO);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" }).format(d);
  return `${day}, ${time}`;
}

function hourInTz(d: Date, tz: string): number {
  const part = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz })
    .formatToParts(d)
    .find((p) => p.type === "hour");
  const h = Number(part?.value ?? NaN);
  return Number.isFinite(h) ? h : d.getHours();
}

/**
 * Propose up to 3 free 30-min slots over the next ~5 business days (9-17 owner-local, weekends
 * skipped, ≥3h lead, spaced apart), labeled in the client's timezone. Null when the calendar is
 * unreachable or genuinely full.
 */
export async function proposeSlots(client: Client): Promise<MeetingOffer | null> {
  try {
    const { freeBusy, firstFreeSlot } = await import("@/lib/friday/google/calendar");
    const now = Date.now();
    const horizon = new Date(now + 7 * 86_400_000);
    const busy = await freeBusy(new Date(now).toISOString(), horizon.toISOString());
    const { clientTimezone } = await import("@/lib/friday/outbound");
    const tz = clientTimezone(client);

    const slots: OfferSlot[] = [];
    let from = new Date(now + MIN_LEAD_MS);
    let guard = 0;
    while (slots.length < 3 && guard++ < 30) {
      const s = firstFreeSlot(busy, from, horizon, SLOT_MINUTES);
      if (!s) break;
      const dow = s.getDay();
      if (dow === 0 || dow === 6) { // weekend → jump to Monday 9am
        const next = new Date(s);
        next.setDate(next.getDate() + (dow === 0 ? 1 : 2));
        next.setHours(9, 0, 0, 0);
        from = next;
        continue;
      }
      // Client-comfort floor (smoke finding): a slot that reads before 9:00 AM in the CLIENT's
      // timezone looks like an odd ask — nudge forward and retry.
      if (hourInTz(s, tz) < 9) {
        from = new Date(s.getTime() + 30 * 60_000);
        continue;
      }
      const end = new Date(s.getTime() + SLOT_MINUTES * 60_000);
      slots.push({ startISO: s.toISOString(), endISO: end.toISOString(), label: slotLabel(s.toISOString(), tz) });
      // One slot per day (smoke finding: 90-min spacing clustered all three options onto one
      // morning) — a human offers a spread, so jump to the NEXT business day for the next option.
      const nextDay = new Date(s);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(9, 0, 0, 0);
      from = nextDay;
    }
    if (!slots.length) return null;
    const offer: MeetingOffer = { id: newId(), clientId: client.id, slots, createdAt: now, expiresAt: now + OFFER_TTL_MS };
    const rows = (await loadOffers()).filter((r) => r.clientId !== client.id); // one live offer per client
    rows.push(offer);
    await saveOffers(rows);
    await logEvent("meeting.offered", { clientId: client.id, slots: slots.map((s) => s.label) });
    return offer;
  } catch (e) {
    await logEvent("meeting.offer_error", { error: String(e).slice(0, 160) }, { level: "warn" });
    return null;
  }
}

/** The numbered lines appended to the (owner-approved) reply. */
export function renderOfferLines(offer: MeetingOffer): string {
  const lines = offer.slots.map((s, i) => `  ${i + 1}. ${s.label}`);
  return `Here are a few times that work on our end:\n${lines.join("\n")}\nReply with the option number (or suggest a time that suits you better) and I'll send over a calendar invite with a Meet link.`;
}

const WORD_ORDINALS: Array<[RegExp, number]> = [
  [/\bfirst\b/i, 0],
  [/\bsecond\b/i, 1],
  [/\bthird\b/i, 2],
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Deterministic slot matcher (eval-locked). Returns the slot INDEX or null — null means "not an
 * unambiguous acceptance", and the normal reply pipeline takes over. Accepts: "option 2" / "#2" /
 * a bare "2" / "second one" / a weekday (+ optional hour) that uniquely identifies one slot.
 */
export function matchSlotReply(text: string, offer: Pick<MeetingOffer, "slots">): number | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const n = offer.slots.length;
  const opt = t.match(/(?:option|choice|slot|#)\s*([1-9])\b/);
  if (opt) { const i = Number(opt[1]) - 1; return i >= 0 && i < n ? i : null; }
  const bare = t.match(/^\s*([1-9])\s*[.!)]?\s*$/);
  if (bare) { const i = Number(bare[1]) - 1; return i >= 0 && i < n ? i : null; }
  for (const [re, i] of WORD_ORDINALS) if (re.test(t) && i < n) return i;
  // Weekday (+ optional hour) — must identify exactly ONE slot.
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(offer.slots[i].startISO);
    const day = WEEKDAYS[d.getUTCDay()]; // label matching is done on words, so use the label too
    const label = offer.slots[i].label.toLowerCase();
    const dayWord = label.split(",")[0]?.trim().toLowerCase() ?? day;
    const fullDay = WEEKDAYS.find((w) => w.startsWith(dayWord.slice(0, 3))) ?? day;
    if (t.includes(fullDay) || t.includes(dayWord)) candidates.push(i);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Disambiguate by hour token appearing in the slot label ("2:00" / "2 pm" / "10:30").
    const hourHits = candidates.filter((i) => {
      const label = offer.slots[i].label.toLowerCase();
      const hm = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
      if (!hm) return false;
      const hour = hm[1];
      return new RegExp(`\\b${hour}(:${hm[2]})?\\s*(am|pm)?\\b`).test(t);
    });
    if (hourHits.length === 1) return hourHits[0];
  }
  return null;
}

/**
 * Confirm a matched slot: re-check free/busy, create the Meet event (Google invites both parties),
 * consume the offer. Returns the routine reply text for the thread.
 */
export async function confirmSlot(client: Client, offer: MeetingOffer, idx: number): Promise<{ booked: boolean; reply: string }> {
  const slot = offer.slots[idx];
  if (!slot) return { booked: false, reply: "" };
  try {
    const { freeBusy, createEvent } = await import("@/lib/friday/google/calendar");
    const busy = await freeBusy(slot.startISO, slot.endISO);
    const s = Date.parse(slot.startISO), e = Date.parse(slot.endISO);
    const clash = busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
    if (clash || s < Date.now()) {
      await consumeOffer(offer.id);
      const { notifyOwner } = await import("@/lib/friday/notify");
      await notifyOwner({
        kind: "meeting", priority: "normal",
        text: `📅 ${client.name} picked ${slot.label} but it's no longer free — grab a time with them directly.`,
        dedupeKey: `meeting-clash:${offer.id}`,
      }).catch(() => {});
      return { booked: false, reply: `Ah — that window just got taken on our side. Let me line up a fresh set of times and get right back to you.` };
    }
    const { ownerEmail } = await import("@/lib/friday/emailAgent");
    const owner = await ownerEmail();
    const attendees = [client.email, owner].filter(Boolean) as string[];
    const res = await createEvent({
      summary: `${client.name} × ${AGENCY} — call`,
      startISO: slot.startISO,
      endISO: slot.endISO,
      attendees,
      description: "Booked by FRIDAY from your reply. The Meet link is attached to this invite.",
      withMeet: true,
    });
    if (!res.ok) {
      await logEvent("meeting.create_error", { clientId: client.id, error: res.error }, { level: "warn" });
      return { booked: false, reply: `I hit a snag getting that on the calendar — let me sort it out and confirm shortly.` };
    }
    await consumeOffer(offer.id);
    await logEvent("meeting.booked", { clientId: client.id, slot: slot.label, eventId: res.id });
    const { notifyOwner } = await import("@/lib/friday/notify");
    await notifyOwner({
      kind: "meeting", priority: "normal",
      text: `📅 Booked: ${client.name} — ${slot.label} (Meet invite sent to both of you).`,
      dedupeKey: `meeting-booked:${res.id}`,
    }).catch(() => {});
    const first = client.name.trim().split(/\s+/)[0] || "there";
    return { booked: true, reply: `Locked in, ${first} — ${slot.label}. The calendar invite with the Meet link is on its way to your inbox. Talk then!` };
  } catch (e) {
    await logEvent("meeting.confirm_error", { error: String(e).slice(0, 160) }, { level: "warn" });
    return { booked: false, reply: "" };
  }
}
