import { NextResponse } from "next/server";
import { twilioConfig } from "@/lib/friday/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phone (Twilio) status + webhook wiring. Inbound SMS/calls only reach FRIDAY if the number's
// webhooks point at a PUBLIC url that tunnels to this localhost server.
function mask(n?: string | null): string | null {
  return n ? n.replace(/.(?=.{4})/g, "•") : null;
}

async function lookupNumber(sid: string, from: string, auth: string): Promise<{ numSid?: string; voiceUrl?: string; smsUrl?: string; error?: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`;
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) return { error: `Twilio ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` };
  const j = await r.json().catch(() => ({}));
  const rec = (j.incoming_phone_numbers ?? [])[0];
  if (!rec) return { error: `Number ${from} isn't on this Twilio account` };
  return { numSid: rec.sid, voiceUrl: rec.voice_url, smsUrl: rec.sms_url };
}

// GET → is Twilio configured, is the owner number set, and where do the webhooks currently point?
export async function GET() {
  const cfg = twilioConfig();
  if (!cfg) return NextResponse.json({ configured: false });
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const num = await lookupNumber(cfg.sid, cfg.from, auth);
  const pathWired = Boolean(num.smsUrl?.includes("/api/channels/twilio/inbound") && num.voiceUrl?.includes("/api/channels/twilio/voice"));

  // Probe the actual webhook host so a dead/ephemeral tunnel doesn't read as "Live".
  let reachable = false;
  const probeBase = (num.smsUrl || num.voiceUrl || "").replace(/\/api\/channels\/twilio\/.*$/, "");
  if (pathWired && probeBase) {
    try {
      // Any HTTP response means the tunnel is up — even a 401/302 from Cloudflare Access counts.
      // Only a thrown network error (dead tunnel) is "not reachable".
      await fetch(`${probeBase}/api/friday/status`, { signal: AbortSignal.timeout(4000) });
      reachable = true;
    } catch { reachable = false; }
  }

  return NextResponse.json({
    configured: true,
    from: mask(cfg.from),
    ownerSet: Boolean(cfg.owner),
    owner: mask(cfg.owner),
    numberSid: num.numSid,
    voiceUrl: num.voiceUrl ?? null,
    smsUrl: num.smsUrl ?? null,
    pathWired,
    reachable,
    wired: pathWired && reachable, // "Live" only when the tunnel actually answers
    error: num.error,
  });
}

// POST { baseUrl } → point the number's SMS + Voice webhooks at <baseUrl>/api/channels/twilio/*.
export async function POST(req: Request) {
  const cfg = twilioConfig();
  if (!cfg) return NextResponse.json({ error: "Twilio not configured — set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER in .env.local" }, { status: 400 });
  const { baseUrl } = await req.json().catch(() => ({}));
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/.+/.test(base)) return NextResponse.json({ error: "baseUrl must be a public https URL that tunnels to this server (:3737)" }, { status: 400 });

  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const num = await lookupNumber(cfg.sid, cfg.from, auth);
  if (!num.numSid) return NextResponse.json({ error: num.error ?? "number not found" }, { status: 502 });

  const form = new URLSearchParams({
    SmsUrl: `${base}/api/channels/twilio/inbound`, SmsMethod: "POST",
    VoiceUrl: `${base}/api/channels/twilio/voice`, VoiceMethod: "POST",
  });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/IncomingPhoneNumbers/${num.numSid}.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) return NextResponse.json({ error: `Twilio ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` }, { status: 502 });
  const j = await r.json().catch(() => ({}));

  // If the number belongs to a Messaging Service, that service's inbound handling OVERRIDES the
  // number's SmsUrl — with UseInboundWebhookOnNumber=false + no inbound_request_url, Twilio
  // receives texts but calls no webhook (received-but-silent). Flip the flag so inbound defers
  // to the number's webhook we just set. (A2P 10DLC registration commonly creates this service.)
  const fixedServices: string[] = [];
  try {
    const svcR = await fetch(`https://messaging.twilio.com/v1/Services?PageSize=50`, { headers: { Authorization: `Basic ${auth}` } });
    if (svcR.ok) {
      for (const s of (await svcR.json()).services ?? []) {
        const pnR = await fetch(`https://messaging.twilio.com/v1/Services/${s.sid}/PhoneNumbers?PageSize=100`, { headers: { Authorization: `Basic ${auth}` } });
        if (!pnR.ok) continue;
        const nums = ((await pnR.json()).phone_numbers ?? []).map((p: Record<string, unknown>) => p.phone_number);
        if (nums.includes(cfg.from) && !s.use_inbound_webhook_on_number) {
          const up = await fetch(`https://messaging.twilio.com/v1/Services/${s.sid}`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ UseInboundWebhookOnNumber: "true" }).toString(),
          });
          if (up.ok) fixedServices.push(String(s.sid));
        }
      }
    }
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true, voiceUrl: j.voice_url, smsUrl: j.sms_url, fixedServices });
}
