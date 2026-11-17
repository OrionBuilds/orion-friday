import { OAuth2Client } from "google-auth-library";
import { logEvent } from "@/lib/persistence/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Gmail → Cloud Pub/Sub → this webhook. Public endpoint (Access-bypassed, see src/middleware.ts)
// — Pub/Sub can't complete a Cloudflare Access login, so authenticity instead rests on the OIDC
// token Pub/Sub attaches when the push subscription is created with a
// --push-auth-service-account. See src/lib/friday/google/gmailWatch.ts for the one-time setup.
//
// Point a Pub/Sub PUSH subscription at:
//   https://<your-tunnel>/api/friday/gmail/push

let verifierClient: OAuth2Client | null = null;
function verifier(): OAuth2Client {
  if (!verifierClient) verifierClient = new OAuth2Client();
  return verifierClient;
}

async function verifyPubSubToken(req: Request): Promise<boolean> {
  const audience = process.env.GMAIL_PUBSUB_AUDIENCE?.trim();
  if (!audience) return false; // fail closed — verification is not optional on a public endpoint
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const ticket = await verifier().verifyIdToken({ idToken: token, audience });
    return Boolean(ticket.getPayload());
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!(await verifyPubSubToken(req))) {
    return new Response("invalid Pub/Sub token", { status: 403 });
  }

  let body: { message?: { data?: string; messageId?: string } } = {};
  try { body = await req.json(); } catch { /* malformed push isn't retryable — ack below regardless */ }

  let decoded: { emailAddress?: string; historyId?: string | number } = {};
  try {
    if (body.message?.data) decoded = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"));
  } catch { /* trigger a scan anyway — it's idempotent */ }

  await logEvent("gmail.push.received", { emailAddress: decoded.emailAddress, historyId: decoded.historyId, messageId: body.message?.messageId }).catch(() => {});

  // ACK Pub/Sub immediately — it expects a fast response and retries on non-2xx. The actual scan
  // runs in the background through the exact same floor/hold/dedup-aware pipeline the 15-min poll
  // uses (triageInboxNow guards against overlapping the periodic tick); a push just means "run it
  // now" instead of waiting.
  void (async () => {
    try {
      const { triageInboxNow } = await import("@/lib/friday/emailAgent");
      const r = await triageInboxNow();
      if (r) await logEvent("gmail.push.triaged", r).catch(() => {});
    } catch (e) {
      await logEvent("gmail.push.error", { error: String(e).slice(0, 300) }, { level: "warn" }).catch(() => {});
    }
  })();

  return new Response("ok", { status: 200 });
}
