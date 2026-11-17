// Google Calendar — scheduling.
import { gfetch } from "./auth";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface CalEvent { id: string; summary: string; start: string; end: string; attendees?: string[]; hangoutLink?: string; }

export async function listEvents(opts: { timeMin?: string; timeMax?: string; max?: number } = {}): Promise<CalEvent[]> {
  const p = new URLSearchParams({
    timeMin: opts.timeMin ?? new Date().toISOString(),
    ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
    singleEvents: "true", orderBy: "startTime", maxResults: String(opts.max ?? 10),
  });
  const r = await gfetch(`${BASE}/calendars/primary/events?${p.toString()}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items ?? []).map((e: Record<string, unknown>) => ({
    id: e.id, summary: e.summary ?? "(no title)",
    start: (e.start as { dateTime?: string; date?: string })?.dateTime ?? (e.start as { date?: string })?.date ?? "",
    end: (e.end as { dateTime?: string; date?: string })?.dateTime ?? (e.end as { date?: string })?.date ?? "",
    attendees: ((e.attendees as { email: string }[]) ?? []).map((a) => a.email),
    hangoutLink: e.hangoutLink,
  }));
}

// Create an event, optionally with a Google Meet link.
export async function createEvent(input: { summary: string; startISO: string; endISO: string; attendees?: string[]; description?: string; withMeet?: boolean }): Promise<{ ok: boolean; id?: string; link?: string; meet?: string; error?: string }> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startISO },
    end: { dateTime: input.endISO },
    attendees: (input.attendees ?? []).map((email) => ({ email })),
  };
  if (input.withMeet) body.conferenceData = { createRequest: { requestId: `friday-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  const r = await gfetch(`${BASE}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, error: `calendar create ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  return { ok: true, id: j.id, link: j.htmlLink, meet: j.hangoutLink };
}

// Move an event (new start/end) and/or edit it. Notifies attendees.
export async function updateEvent(id: string, patch: { startISO?: string; endISO?: string; summary?: string }): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {};
  if (patch.startISO) body.start = { dateTime: patch.startISO };
  if (patch.endISO) body.end = { dateTime: patch.endISO };
  if (patch.summary) body.summary = patch.summary;
  const r = await gfetch(`${BASE}/calendars/primary/events/${id}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(body) });
  return r.ok ? { ok: true } : { ok: false, error: `calendar update ${r.status}` };
}

// Cancel an event (notifies attendees).
export async function deleteEvent(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await gfetch(`${BASE}/calendars/primary/events/${id}?sendUpdates=all`, { method: "DELETE" });
  return r.ok ? { ok: true } : { ok: false, error: `calendar delete ${r.status}` };
}

// Busy intervals on the primary calendar in a window — for "find a time" free/busy scheduling.
export async function freeBusy(timeMinISO: string, timeMaxISO: string): Promise<{ start: string; end: string }[]> {
  const r = await gfetch(`${BASE}/freeBusy`, { method: "POST", body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: "primary" }] }) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.calendars?.primary?.busy ?? []) as { start: string; end: string }[];
}

// First open `durationMin` slot within [from, to] during business hours (default 9–17 local),
// avoiding busy intervals. Returns the slot's start Date, or null if none.
export function firstFreeSlot(busy: { start: string; end: string }[], from: Date, to: Date, durationMin: number, dayStartHour = 9, dayEndHour = 17): Date | null {
  const slotMs = durationMin * 60_000;
  const busyRanges = busy.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()] as [number, number]).sort((a, b) => a[0] - b[0]);
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  const end = to.getTime();
  let guard = 0;
  while (cur.getTime() + slotMs <= end && guard++ < 5000) {
    const h = cur.getHours();
    if (h < dayStartHour) { cur.setHours(dayStartHour, 0, 0, 0); continue; }
    if (h >= dayEndHour) { cur.setDate(cur.getDate() + 1); cur.setHours(dayStartHour, 0, 0, 0); continue; }
    const s = cur.getTime(), e = s + slotMs;
    const clash = busyRanges.find(([bs, be]) => s < be && e > bs);
    if (clash) { cur.setTime(clash[1]); continue; }
    return new Date(s);
  }
  return null;
}
