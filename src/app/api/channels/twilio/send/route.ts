import { NextResponse } from "next/server";
import { sendSMS, twilioConfig } from "@/lib/friday/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → whether Twilio is configured (for the UI).
export async function GET() {
  const cfg = twilioConfig();
  return NextResponse.json({ configured: Boolean(cfg), from: cfg?.from ?? null, owner: cfg?.owner ?? null });
}

// POST { to?, body } → send an SMS (defaults to the owner's number).
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const text = String(b.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });
  const cfg = twilioConfig();
  const to = String(b.to ?? cfg?.owner ?? "").trim();
  if (!to) return NextResponse.json({ error: "no recipient (pass `to` or set FRIDAY_OWNER_NUMBER)" }, { status: 400 });
  const res = await sendSMS(to, text);
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
