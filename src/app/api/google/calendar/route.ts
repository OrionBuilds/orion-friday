import { NextResponse } from "next/server";
import { listEvents, createEvent } from "@/lib/friday/google/calendar";
import { googleConfigured } from "@/lib/friday/google/auth";
import { logEvent } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notConnected = () => NextResponse.json({ error: "Google not connected" }, { status: 400 });

// GET ?days=  → upcoming events.  POST { summary, startISO, endISO, attendees?, withMeet? } → create.
export async function GET(req: Request) {
  if (!googleConfigured()) return notConnected();
  const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
  const timeMax = new Date(Date.now() + days * 86400_000).toISOString();
  return NextResponse.json({ events: await listEvents({ timeMax, max: 20 }) });
}

export async function POST(req: Request) {
  if (!googleConfigured()) return notConnected();
  const b = await req.json().catch(() => ({}));
  if (!b.summary || !b.startISO || !b.endISO) return NextResponse.json({ error: "summary, startISO, endISO required" }, { status: 400 });
  const res = await createEvent({ summary: b.summary, startISO: b.startISO, endISO: b.endISO, attendees: b.attendees, description: b.description, withMeet: b.withMeet !== false });
  await logEvent("calendar.create", { summary: b.summary, ok: res.ok });
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
