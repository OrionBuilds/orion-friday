// FRIDAY host gate.
//
// FRIDAY binds 127.0.0.1, but README tells you to run
//   cloudflared tunnel --url http://localhost:3737
// so Twilio can deliver SMS/voice webhooks. That tunnel exposes the WHOLE app —
// all 237 API routes and the entire dashboard UI — not just the two webhook paths.
// Before this gate, anyone with the tunnel URL could POST /api/claude/chat or
// /api/codex/goals and get an agent CLI spawned on this machine.
//
// Rule: a request whose Host is not loopback may only reach PUBLIC_PATHS —
// UNLESS it carries a Cloudflare Access assertion (Cf-Access-Jwt-Assertion), in
// which case Access has already authenticated the user (per the Access application's
// policy) and the request may reach the full app.
// Everything else 404s (not 403 — a 403 confirms the route exists).
//
// The local browser UI is unaffected: it talks to localhost:3737, so every route
// behaves exactly as before.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";

// Paths that MUST be reachable from outside, because an external service calls them:
//   inbound / voice — Twilio webhooks (configured in the Twilio console)
//   tts             — Twilio fetches this for <Play>; already signature-checked (ttsSigValid)
//   gmail/push      — Cloud Pub/Sub push subscription (Gmail watch); Pub/Sub can't complete a
//                      CF Access login, so it self-verifies via a Google-signed OIDC token
//                      instead (see api/friday/gmail/push/route.ts) — verification is required
//                      there (GMAIL_PUBSUB_AUDIENCE unset ⇒ every request is rejected, fail closed).
// Deliberately NOT included:
//   /api/channels/twilio/send — outbound only, we call Twilio, never the reverse
//   OAuth callbacks — GOOGLE_REDIRECT_URI and ORION_REDIRECT_URI both default to
//   localhost, so the browser reaches them locally. If you repoint either at the
//   tunnel, add it via FRIDAY_PUBLIC_PATHS below.
const PUBLIC_PATHS = new Set<string>([
  "/api/channels/twilio/inbound",
  "/api/channels/twilio/voice",
  "/api/friday/gmail/push",
]);

// Escape hatch for extra public paths, comma-separated.
// NOTE: Next inlines process.env in middleware at BUILD time — changing this
// requires a rebuild, not just a restart.
const EXTRA = (process.env.FRIDAY_PUBLIC_PATHS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Strip the port and any IPv6 brackets, then test against the loopback set.
function isLoopbackHost(raw: string | null): boolean {
  if (!raw) return false;
  const host = raw.trim().toLowerCase();
  // IPv6 literal: [::1]:3737
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return LOOPBACK.has(hostname);
}

// ── Cloudflare Access JWT verification ──────────────────────────────────────
// A request arriving off-box with Cf-Access-Jwt-Assertion is trusted only if the
// assertion is a valid JWT for THIS Access application: signature verified against
// the team's JWKS, `aud` equal to this app's AUD tag, and `iss` equal to the team
// domain. Presence alone is not enough — a forged header, or a valid token minted
// for a different Access app on the same team, must be rejected.
// NOTE: Next inlines process.env in middleware at BUILD time, so changing these
// requires a rebuild, not just a restart (same as FRIDAY_PUBLIC_PATHS above).
const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD?.trim();
const CF_ISSUER = CF_ACCESS_TEAM_DOMAIN ? `https://${CF_ACCESS_TEAM_DOMAIN}` : "";

// createRemoteJWKSet fetches the keys once and caches them (refetching only on an
// unknown kid, with a cooldown) — so we do not hit Cloudflare on every request.
let cfJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function cfKeySet() {
  if (!cfJwks) cfJwks = createRemoteJWKSet(new URL(`${CF_ISSUER}/cdn-cgi/access/certs`));
  return cfJwks;
}

async function accessJwtValid(token: string): Promise<boolean> {
  // Fail closed when unconfigured: without both values we cannot verify, so we
  // must NOT fall back to trusting the header's presence.
  if (!CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) return false;
  try {
    await jwtVerify(token, cfKeySet(), { issuer: CF_ISSUER, audience: CF_ACCESS_AUD });
    return true;
  } catch {
    return false; // bad signature, wrong aud/iss, expired, or JWKS fetch failed
  }
}

export async function middleware(req: NextRequest) {
  // Check BOTH headers and require both to be loopback-or-absent. A proxy may
  // preserve Host and signal the real origin via X-Forwarded-Host, so treating
  // either as external is the fail-closed direction.
  const host = req.headers.get("host");
  const forwarded = req.headers.get("x-forwarded-host");

  const local = isLoopbackHost(host) && (forwarded === null || isLoopbackHost(forwarded));
  if (local) return NextResponse.next();

  // Cloudflare Access-authenticated requests may reach the full app — but only
  // after we VERIFY the assertion (signature + aud + iss), not merely that the
  // header exists. FRIDAY binds 127.0.0.1 and is reachable off-box only through
  // the Access-protected tunnel, so a verified assertion proves the request
  // cleared this Access application. Twilio webhooks arrive without it and fall
  // through to PUBLIC_PATHS below.
  const assertion = req.headers.get("cf-access-jwt-assertion");
  if (assertion && (await accessJwtValid(assertion))) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || EXTRA.includes(pathname)) {
    return NextResponse.next();
  }

  console.warn(`[host-gate] blocked ${req.method} ${pathname} from host=${host ?? "(none)"}`);
  return new NextResponse("Not Found", { status: 404 });
}

export const config = {
  // Gate everything except Next's own static assets. The dashboard UI needs the
  // gate as much as the API does — it exposes clients, approvals and agent controls.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
