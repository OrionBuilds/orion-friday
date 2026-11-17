// FRIDAY ↔ Google Workspace — OAuth2 + access-token management.
//
// Reuses the Orion Google Cloud OAuth *client* (same client_id/secret) but holds FRIDAY's
// OWN refresh token so it works standalone. Credentials come from env (.env.local):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// Get the refresh token once via the /api/google/auth consent flow (adds a localhost
// redirect URI to the OAuth client), or paste an existing Orion refresh token.
//
// Access tokens are exchanged from the refresh token on demand and cached until ~expiry.

import { legacyChannelsOn } from "@/lib/friday/legacyChannels";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// FRIDAY can connect TWO Google accounts: the "owner" (the owner — reads client email, calendar, drive)
// and "friday" (her own Workspace account — sends client replies from her address). Everything below
// is keyed by account; callers that don't care default to "owner", so existing behaviour is unchanged.
export type GoogleAccount = "owner" | "friday";
export const GOOGLE_ACCOUNTS: GoogleAccount[] = ["owner", "friday"];

// A local sidecar so tokens obtained via the consent flow persist without editing .env.local.
const TOKEN_STORE = path.join(os.homedir(), ".agentic-os", "friday", "google-token.json");

// Scopes requested at consent. Includes the Meet REST API scope (meetings.space.readonly)
// now that it's enabled on the OAuth client — so google/meet.ts can read structured
// transcripts via the Meet API, with the Drive-search path as a fallback.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  // Google Docs deliverables (editable proposals/SOWs/reports). Needs one re-consent to take effect.
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  // People API — search saved Contacts + "Other contacts" (people you email with)
  // to autofill the new-client form. Read-only.
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];

export function redirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || "http://localhost:3737/api/google/callback";
}

interface AccountToken { refresh_token?: string; }
// Keyed by account. Legacy shape was a flat { refresh_token } — migrated to the "owner" slot on read.
type TokenStore = Partial<Record<GoogleAccount, AccountToken>>;
function readStore(): TokenStore {
  try {
    const raw = JSON.parse(readFileSync(TOKEN_STORE, "utf8"));
    if (raw && typeof raw.refresh_token === "string") return { owner: { refresh_token: raw.refresh_token } }; // legacy flat → owner
    return raw ?? {};
  } catch { return {}; }
}
function writeStore(t: TokenStore): void {
  try { mkdirSync(path.dirname(TOKEN_STORE), { recursive: true }); writeFileSync(TOKEN_STORE, JSON.stringify(t, null, 2)); } catch { /* ignore */ }
}

export function googleClient(): { id: string; secret: string } | null {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return { id, secret };
}

export function refreshToken(account: GoogleAccount = "owner"): string | null {
  const store = readStore();
  if (account === "owner") return process.env.GOOGLE_REFRESH_TOKEN?.trim() || store.owner?.refresh_token || null;
  return process.env.GOOGLE_REFRESH_TOKEN_FRIDAY?.trim() || store.friday?.refresh_token || null;
}

export function googleConfigured(account: GoogleAccount = "owner"): boolean {
  // Retired (2026-10): Google Workspace is gone (Microsoft, via Clara and the OS). Every Gmail/Calendar/Drive
  // path checks this first, so false here turns them all off. Rollback: FRIDAY_LEGACY_CHANNELS=on.
  if (!legacyChannelsOn()) return false;
  return Boolean(googleClient() && refreshToken(account));
}

// Build the consent URL (offline access → refresh token; prompt=consent to force it). `account` rides
// in the OAuth `state` param so the callback knows which slot (owner/friday) to store the token in.
export function consentUrl(account: GoogleAccount = "owner"): string | null {
  const client = googleClient();
  if (!client) return null;
  const p = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    state: account,
    scope: GOOGLE_SCOPES.join(" "),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// Exchange an auth code (from the callback) for tokens; persists the refresh token to `account`'s slot.
export async function exchangeCode(code: string, account: GoogleAccount = "owner"): Promise<{ ok: boolean; error?: string }> {
  const client = googleClient();
  if (!client) return { ok: false, error: "GOOGLE_CLIENT_ID/SECRET not set" };
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: client.id, client_secret: client.secret,
      redirect_uri: redirectUri(), grant_type: "authorization_code",
    }),
  });
  if (!r.ok) return { ok: false, error: `token exchange ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  if (j.refresh_token) {
    const store = readStore();
    store[account] = { refresh_token: j.refresh_token };
    writeStore(store);
    accessCache.delete(account); // force a fresh access token next call
  }
  return { ok: Boolean(j.refresh_token || j.access_token) };
}

// ── access token cache (per account) ──
const accessCache = new Map<GoogleAccount, { token: string; exp: number }>();

export async function getAccessToken(account: GoogleAccount = "owner"): Promise<string> {
  const cached = accessCache.get(account);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const client = googleClient();
  const rt = refreshToken(account);
  if (!client || !rt) throw new Error(`Google (${account}) not connected — connect via /api/google/auth?account=${account}`);
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: rt, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(`Google (${account}) token refresh ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  const entry = { token: j.access_token as string, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  accessCache.set(account, entry);
  return entry.token;
}

// Authed fetch helper for Google REST APIs. `account` selects which connected account's token to use
// (defaults to owner — so the ~30 existing calendar/drive/meet/contacts callers are untouched).
export async function gfetch(url: string, init: RequestInit = {}, account: GoogleAccount = "owner"): Promise<Response> {
  const token = await getAccessToken(account);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}
