import { NextResponse } from "next/server";
import { generateDream } from "@/lib/friday/dream";
import { googleConfigured } from "@/lib/friday/google/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Generate today's brief and (if Google is connected) EMAIL it to the owner. Owner rule 2026-09-24:
// FRIDAY never texts the owner. Meant to be hit by a scheduler each morning (e.g. a cron job).
export async function POST() {
  const dream = await generateDream(true);
  const lines = [dream.greeting, ...dream.prescriptions.map((p, i) => `${i + 1}. ${p.title} → ${p.action}`)];
  const text = lines.join("\n").slice(0, 4000);

  if (!googleConfigured()) {
    return NextResponse.json({ ok: true, sent: false, reason: "Google not connected", brief: text });
  }
  const { sendEmail, getProfile } = await import("@/lib/friday/google/gmail");
  const me = (await getProfile()).email;
  if (!me) return NextResponse.json({ ok: true, sent: false, reason: "no owner email", brief: text });
  const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const res = await sendEmail({ to: me, subject: `FRIDAY morning brief — ${date}`, body: text, agent: "FRIDAY" });
  return NextResponse.json({ ok: res.ok, sent: res.ok, channel: "email", error: res.error, brief: text });
}
