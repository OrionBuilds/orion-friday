import { twilioSignatureValid, twilioPublicUrl } from "@/lib/friday/channels";
import { logEvent } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Twilio Voice webhook — CLARA is the only agent who speaks (the owner's decision), so a call to
// FRIDAY's number no longer gets a spoken conversation with her: it's transferred straight to
// CLARA's line on the first ring, before any greeting plays. FRIDAY still works exactly as
// before over chat, email, and SMS — only the "answer and talk" behavior moved to CLARA.
// Point the number's "A CALL COMES IN" webhook (POST) at this same URL; nothing else changes.
function xml(s: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${s}`, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The number CLARA answers on. Set in FRIDAY's own env (she's a separate process/app from
// CLARA, so this isn't read from CLARA's config) — same value as CLARA_TWILIO_NUMBER in her env.
function claraNumber(): string | null {
  return process.env.CLARA_TWILIO_NUMBER?.trim() || null;
}

export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch { /* first hit */ }
  // Public endpoint (Access-bypassed) — reject anything that isn't a genuine Twilio request.
  if (!twilioSignatureValid(req, twilioPublicUrl(req), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }

  const to = claraNumber();
  if (!to) {
    await logEvent("voice.transfer_misconfigured", { reason: "CLARA_TWILIO_NUMBER not set" }, { level: "error" }).catch(() => {});
    // Honest fallback — never claim a transfer that can't happen. Polly, not FRIDAY's voice:
    // she doesn't speak on this line anymore, not even for an error message.
    return xml(`<Response><Say voice="Polly.Joanna">This line isn't taking calls right now. Please try again shortly.</Say></Response>`);
  }

  await logEvent("voice.transferred_to_clara", { from: params.From ?? "" }).catch(() => {});
  return xml(`<Response><Dial>${esc(to)}</Dial></Response>`);
}
