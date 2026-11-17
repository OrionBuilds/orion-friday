import { NextResponse } from "next/server";
import { sendEmail, searchMessages } from "@/lib/friday/google/gmail";
import { googleConfigured } from "@/lib/friday/google/auth";
import { logEvent } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notConnected = () => NextResponse.json({ error: "Google not connected" }, { status: 400 });

// GET ?q=…  → search recent messages.  POST { to, subject, body } → send.
export async function GET(req: Request) {
  if (!googleConfigured()) return notConnected();
  const q = new URL(req.url).searchParams.get("q") ?? "newer_than:7d";
  return NextResponse.json({ messages: await searchMessages(q, 10) });
}

export async function POST(req: Request) {
  if (!googleConfigured()) return notConnected();
  const b = await req.json().catch(() => ({}));
  const to = String(b.to ?? "").trim();
  const subject = String(b.subject ?? "").trim();
  const body = String(b.body ?? "");
  if (!to || !subject || !body) return NextResponse.json({ error: "to, subject, body required" }, { status: 400 });
  const res = await sendEmail({ to, subject, body, cc: b.cc, replyToThreadId: b.replyToThreadId });
  await logEvent("gmail.send", { to, subject, ok: res.ok }, { level: res.ok ? "info" : "warn" });
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}
