// FRIDAY channels — Twilio SMS (in/out) + ElevenLabs voice.
// All keys are read SERVER-SIDE from env (loaded from .env.local) with a ~/.hermes/.env
// fallback for the ElevenLabs key (shared with Hermes/Jarvis). Never sent to the client.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resolvePrincipalByPhone } from "@autom8ionlab/agent-core";
import { samePhone } from "@/lib/friday/phone";
import { dial } from "@/lib/friday/dials";
import { legacyChannelsOn } from "@/lib/friday/legacyChannels";
import { cachedAgentSettings, settingsFor, voiceFor } from "@/lib/friday/agentSettings";

function fromHermesEnv(key: string): string | null {
  for (const f of [path.join(os.homedir(), ".hermes", ".env"), path.join(os.homedir(), ".hermes", "profiles", "main", ".env")]) {
    try {
      const m = readFileSync(f, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  return null;
}

// ── Twilio ────────────────────────────────────────────────────────────────
export interface TwilioConfig {
  sid: string; token: string; from: string; owner?: string;
}
export function twilioConfig(): TwilioConfig | null {
  // Retired (2026-10): FRIDAY has no SMS/voice line. Everything that sends or answers through Twilio keys off
  // this, so returning null here turns the whole channel off in one place. Rollback: FRIDAY_LEGACY_CHANNELS=on.
  if (!legacyChannelsOn()) return null;
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (!sid || !token || !from) return null;
  return { sid, token, from, owner: process.env.FRIDAY_OWNER_NUMBER?.trim() };
}

// ── Owner gate (owner rule 2026-09-24) ──────────────────────────────────────
// FRIDAY does not text or phone the owner on her own initiative — everything reaches them by email
// or through CLARA's morning brief, and genuine emergencies go to CLARA (delegateBridge.
// escalateToClara), who is the only agent allowed to ring them. The gate lives HERE, in the one
// helper every SMS goes through, so no future caller can text them by accident. The single
// exception is a reply to a text they just sent: only the signature-verified Twilio inbound route may
// pass `inboundReply`, and even then the reply must go to the number that texted and a user row
// from that number must exist in the last 15 minutes (so a "reply" helper can't be reused as a push).
const INBOUND_REPLY_WINDOW_MS = 15 * 60_000;

export interface SendSMSOpts {
  /** Set ONLY by the Twilio inbound webhook: this text answers a message `from` just sent. */
  inboundReply?: { from: string };
}

export function isOwnerNumber(to: string): boolean {
  const owner = twilioConfig()?.owner;
  if (owner && samePhone(to, owner)) return true;
  try {
    return Boolean(resolvePrincipalByPhone(to));
  } catch {
    return false;
  }
}

// The inbound webhook stamps the owner's number + time here (markOwnerInbound); sendSMS's reply
// exception checks it. File-backed so a restart inside the 15-minute window still lets the
// in-flight reply out. Nothing else writes this file.
async function ownerInboundFile(): Promise<string> {
  const { FRIDAY_DATA_DIR } = await import("@/lib/persistence/store");
  return path.join(FRIDAY_DATA_DIR, "owner-inbound.json");
}

export async function markOwnerInbound(from: string): Promise<void> {
  try {
    const { promises: fsp } = await import("node:fs");
    const f = await ownerInboundFile();
    await fsp.mkdir(path.dirname(f), { recursive: true }).catch(() => {});
    await fsp.writeFile(f, JSON.stringify({ from, at: new Date().toISOString() }), "utf8");
  } catch { /* best-effort — the reply exception then fails closed */ }
}

async function recentInboundFrom(from: string): Promise<boolean> {
  try {
    const { promises: fsp } = await import("node:fs");
    const j = JSON.parse(await fsp.readFile(await ownerInboundFile(), "utf8")) as { from?: string; at?: string };
    return Boolean(j.from && j.at && samePhone(j.from, from) && Date.now() - Date.parse(j.at) <= INBOUND_REPLY_WINDOW_MS);
  } catch {
    return false;
  }
}

/** True when FRIDAY may text the owner unprompted (dial `owner_sms`). Default off. */
export function ownerSmsEnabled(): boolean {
  return dial("owner_sms") === "on";
}
/** True when FRIDAY may phone the owner (dial `owner_calls`). Default off, no exceptions. */
export function ownerCallsEnabled(): boolean {
  return dial("owner_calls") === "on";
}

export async function sendSMS(to: string, body: string, opts: SendSMSOpts = {}): Promise<{ ok: boolean; error?: string; sid?: string; blocked?: boolean }> {
  const cfg = twilioConfig();
  if (!cfg) return { ok: false, error: "Twilio not configured (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER in .env.local)" };
  if (isOwnerNumber(to) && !ownerSmsEnabled()) {
    const reply = opts.inboundReply;
    const allowed = Boolean(reply && samePhone(reply.from, to) && (await recentInboundFrom(reply.from)));
    if (!allowed) {
      const { logEvent } = await import("@/lib/persistence/store");
      const caller = (new Error().stack ?? "").split("\n").slice(2, 4).map((l) => l.trim()).join(" <- ");
      await logEvent("owner_sms.blocked", { body: body.slice(0, 120), caller, reply: Boolean(reply) }, { level: "warn" }).catch(() => {});
      return { ok: false, blocked: true, error: "owner sms disabled" };
    }
  }
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: cfg.from, Body: body.slice(0, 1500) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { ok: false, error: `Twilio ${r.status}: ${t.slice(0, 200)}` };
  }
  const j = await r.json().catch(() => ({}));
  return { ok: true, sid: j.sid };
}

// Governed client SMS (1.3/1.4). Every PROACTIVE/autonomous text to a client goes through here: it
// applies the outbound rate caps + global breaker and defers quiet-hours sends to the morning. Owner
// SMS is gated separately inside sendSMS (see the owner gate above).
export async function sendClientSMS(
  to: string, body: string, meta: { clientId?: string; kind?: string; client?: import("@/lib/friday/types").Client | null } = {},
): Promise<{ ok: boolean; queued?: boolean; blocked?: boolean; error?: string; sid?: string }> {
  // Master gate: FRIDAY never texts clients (CLARA-only comms; owner sends). Default-off.
  const { clientCommsEnabled } = await import("@/lib/friday/clientComms");
  if (!clientCommsEnabled()) {
    const { logEvent } = await import("@/lib/persistence/store");
    await logEvent("client_comms.blocked", { channel: "sms", to }, { level: "warn" }).catch(() => {});
    return { ok: false, blocked: true, error: "client comms disabled" };
  }
  const { gateOutbound, recordSent, recordBlocked, enqueue, threadKeyFor } = await import("@/lib/friday/outbound");
  const m = { channel: "sms" as const, to, threadKey: threadKeyFor("sms", to), clientId: meta.clientId, kind: meta.kind ?? "notify" };
  const gate = await gateOutbound(m, { deferrable: true, client: meta.client });
  if (gate.action === "block") { await recordBlocked(m, gate.reason); return { ok: false, blocked: true, error: gate.reason }; }
  if (gate.action === "queue") { await enqueue(m, gate.sendAfterMs, gate.reason, { body }); return { ok: true, queued: true }; }
  const res = await sendSMS(to, body);
  if (res.ok) {
    await recordSent(m);
    // Audit gap 10: a direct client SMS lands in OS Conversations too. Tolerant — never fails the send.
    const { logClientConversation } = await import("@/lib/friday/conversationLog");
    await logClientConversation({
      channel: "sms", direction: "outbound", body,
      contactId: (meta.client as { osContactId?: string } | null | undefined)?.osContactId,
      externalId: `friday-sms:${res.sid ?? `${to}:${Date.now()}`}`,
      metadata: { to, kind: meta.kind ?? "notify" },
    }).catch(() => false);
  }
  return res;
}

// TwiML reply for the inbound webhook. Escapes XML.
export function twiml(message: string): string {
  const esc = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${esc}</Message></Response>`;
}

// Place an OUTBOUND call that speaks `message` to the owner/recipient (e.g. a critical-approval
// alert). Uses inline TwiML: FRIDAY's ElevenLabs voice when FRIDAY_PUBLIC_URL is set (signed /tts
// Play), else Polly. Returns the call sid. Best-effort; guarded by twilioConfig().
export async function placeCall(to: string, message: string): Promise<{ ok: boolean; sid?: string; error?: string; blocked?: boolean }> {
  const cfg = twilioConfig();
  if (!cfg) return { ok: false, error: "Twilio not configured" };
  if (isOwnerNumber(to) && !ownerCallsEnabled()) {
    const { logEvent } = await import("@/lib/persistence/store");
    await logEvent("owner_call.blocked", { message: message.slice(0, 120) }, { level: "warn" }).catch(() => {});
    return { ok: false, blocked: true, error: "owner calls disabled" };
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const base = process.env.FRIDAY_PUBLIC_URL?.trim().replace(/\/$/, "");
  const say = base
    ? `<Play>${base}/api/channels/twilio/tts?text=${encodeURIComponent(message.slice(0, 850))}&amp;sig=${ttsSign(message.slice(0, 850))}</Play>`
    : `<Say voice="Polly.Joanna">${esc(message.slice(0, 850))}</Say>`;
  const twimlDoc = `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="1"/>${say}</Response>`;
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: cfg.from, Twiml: twimlDoc });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Calls.json`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
  });
  if (!r.ok) return { ok: false, error: `Twilio call ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json().catch(() => ({}));
  return { ok: true, sid: j.sid };
}

// ── Webhook authenticity (the Twilio paths are PUBLIC — Cloudflare Access bypasses them) ────
// Reconstruct the public URL Twilio signed: tunnel proto+host (from forwarded headers) + path.
export function twilioPublicUrl(req: Request, includeQuery = false): string {
  const host = req.headers.get("host") ?? "localhost:3737";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const u = new URL(req.url);
  return `${proto}://${host}${u.pathname}${includeQuery ? u.search : ""}`;
}

// Verify Twilio's X-Twilio-Signature = base64(HMAC-SHA1(url + sorted POST params), authToken).
// Enforced by default; set TWILIO_ENFORCE_SIGNATURE=false to disable (e.g. while debugging a
// proxy that rewrites the URL). No token configured → don't block (dev).
// The dev-mode escape hatch and the "no token configured" fallback must NEVER apply in
// production — previously both silently accepted unsigned requests in prod too, letting anyone
// forge inbound Twilio webhooks (SMS/voice). Mirrors CLARA's fixed twilioSignatureValid().
export function twilioSignatureValid(req: Request, url: string, params: Record<string, string>): boolean {
  const isProd = process.env.NODE_ENV === "production";
  if (process.env.TWILIO_ENFORCE_SIGNATURE === "false") {
    if (isProd) throw new Error("TWILIO_ENFORCE_SIGNATURE=false is not permitted in production");
    return true;
  }
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token) {
    if (isProd) return false; // fail closed in prod — an unset token must not open the gate
    return true; // fail open only for local dev convenience
  }
  const header = req.headers.get("x-twilio-signature");
  if (!header) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signed-URL token for the public <Play> TTS path — Twilio does NOT sign media fetches, so we
// mint our own HMAC over the text (server-only key) so arbitrary callers can't burn TTS credits.
export function ttsSign(text: string): string {
  // Fail closed: an unset token must never fall back to a guessable hardcoded
  // key (mirrors twilioSignatureValid above). The only caller, placeCall(),
  // guards on twilioConfig() first, so the token is present in practice.
  const key = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!key) throw new Error("ttsSign requires TWILIO_AUTH_TOKEN to be set");
  return crypto.createHmac("sha256", key).update(text).digest("hex").slice(0, 24);
}
export function ttsSigValid(text: string, sig: string | null): boolean {
  if (!sig) return false;
  let expected: string;
  try { expected = ttsSign(text); }
  catch { return false; } // not configured → no signature can be valid
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ElevenLabs voice (FRIDAY speaking) ─────────────────────────────────────
export function elevenKey(): string | null {
  return process.env.ELEVENLABS_API_KEY?.trim() || fromHermesEnv("ELEVENLABS_API_KEY");
}
export function elevenVoiceId(): string {
  // OS Settings → AI Agents (FRIDAY's voice) wins when set; else ELEVENLABS_VOICE_ID; else Rachel
  // (warm female) — matches FRIDAY. voiceFor() only returns an explicit, available, well-formed id.
  const osVoiceId = voiceFor(settingsFor(cachedAgentSettings())).voiceId;
  if (osVoiceId) return osVoiceId;
  const v = process.env.ELEVENLABS_VOICE_ID?.trim() || fromHermesEnv("ELEVENLABS_VOICE_ID");
  return v && /^[A-Za-z0-9]{16,}$/.test(v) ? v : "21m00Tcm4TlvDq8ikWAM";
}

// Voice tuning: the OS voice settings (0..1) win when set, else the env/default below.
function voiceNum(osValue: number | undefined, name: string, def: number): number {
  return osValue ?? envNum(name, def);
}

// Read a 0..1 tuning number from env, clamped; falls back to the default if unset/invalid.
function envNum(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
}

// Small in-memory cache so repeated phrases (greetings, "Anything else?", and Twilio's own re-fetches
// of the same <Play> URL) never regenerate — instant + saves credits. FIFO-evicted.
const _ttsCache = new Map<string, Buffer>();
const TTS_CACHE_MAX = 80;

// Audio bytes from ElevenLabs. `telephony` → 8kHz μ-law (the PSTN-native format Twilio plays with NO
// lossy transcode — fixes the muffled "bad connection" of a 44.1kHz MP3 over a phone). Web keeps MP3.
export async function elevenTTSAudio(text: string, opts: { telephony?: boolean } = {}): Promise<{ buf?: Buffer; error?: string }> {
  const key = elevenKey();
  if (!key) return { error: "ElevenLabs not connected — add ELEVENLABS_API_KEY to .env.local" };
  const vid = elevenVoiceId();
  const osVoice = voiceFor(settingsFor(cachedAgentSettings()));
  const voiceSettings = {
    stability: voiceNum(osVoice.stability, "ELEVENLABS_STABILITY", 0.4),
    similarity_boost: voiceNum(osVoice.similarity_boost, "ELEVENLABS_SIMILARITY", 0.85),
    style: voiceNum(osVoice.style, "ELEVENLABS_STYLE", 0.35),
    use_speaker_boost: osVoice.use_speaker_boost ?? true,
  };
  const fmt = opts.telephony ? "ulaw_8000" : "mp3_44100_128";
  const cacheKey = `${vid}:${fmt}:${JSON.stringify(voiceSettings)}:${text}`;
  const hit = _ttsCache.get(cacheKey);
  if (hit) return { buf: hit };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=${fmt}&optimize_streaming_latency=4`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 2500),
      model_id: "eleven_flash_v2_5",
      // Tuned for a natural, warm conversational read. OS voice settings, else env-overridable per-voice
      // without a code change: ELEVENLABS_STABILITY (0-1, lower = more expressive/varied),
      // ELEVENLABS_SIMILARITY, ELEVENLABS_STYLE.
      voice_settings: voiceSettings,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return { error: `ElevenLabs ${r.status}: ${detail.slice(0, 160)}` };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  _ttsCache.set(cacheKey, buf);
  if (_ttsCache.size > TTS_CACHE_MAX) { const first = _ttsCache.keys().next().value; if (first) _ttsCache.delete(first); }
  return { buf };
}

export async function elevenTTS(text: string): Promise<{ audio?: string; error?: string }> {
  const res = await elevenTTSAudio(text);
  if (res.buf) return { audio: `data:audio/mp3;base64,${res.buf.toString("base64")}` };
  return { error: res.error };
}
