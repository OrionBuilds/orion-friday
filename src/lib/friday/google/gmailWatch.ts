// Gmail push notifications (Cloud Pub/Sub) — lets new inbound mail trigger inbox triage
// immediately instead of waiting for the 15-min poll (emailAgent.processInbox via scheduler.ts).
//
// One-time GCP setup per account you want push for (see README "Gmail push setup" section):
//   1. Create a Pub/Sub topic and grant gmail-api-push@system.gserviceaccount.com the
//      roles/pubsub.publisher role on it — Gmail requires exactly this service account.
//   2. Create a PUSH subscription on that topic pointing at
//        <FRIDAY_PUBLIC_URL>/api/friday/gmail/push
//      with OIDC auth enabled (--push-auth-service-account + --push-auth-token-audience) so the
//      webhook can verify a request genuinely came from Pub/Sub.
//   3. Set GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic> and GMAIL_PUBSUB_AUDIENCE=<the
//      audience you configured> in .env.local, then restart.
//
// Without GMAIL_PUBSUB_TOPIC set, everything here is a no-op and FRIDAY behaves exactly as
// before (15-min poll only) — this is additive, never a hard dependency.
import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";
import { gfetch, googleConfigured, GOOGLE_ACCOUNTS, type GoogleAccount } from "./auth";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const STATE_FILE = path.join(FRIDAY_DATA_DIR, "gmail-watch.json");

export interface WatchState {
  historyId?: string;
  expiration?: number; // epoch ms, per Gmail's watch response
  lastRenewedAt?: string;
}
type Store = Partial<Record<GoogleAccount, WatchState>>;

async function loadStateFile(): Promise<Store> {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return {}; }
}
async function saveStateFile(s: Store): Promise<void> {
  try { await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

export function pubsubTopic(): string | null {
  return process.env.GMAIL_PUBSUB_TOPIC?.trim() || null;
}
export function gmailPushEnabled(): boolean {
  return Boolean(pubsubTopic());
}

// Register (or renew) push notifications for one account's INBOX. Idempotent — Gmail's watch
// call just extends the expiration and returns the current historyId, so calling this on a
// timer IS the documented renewal path (watch lapses after 7 days; Google recommends renewing
// at least daily so a missed renewal never leaves more than ~a day resting on the poll fallback).
export async function startWatch(account: GoogleAccount): Promise<{ ok: boolean; error?: string }> {
  const topic = pubsubTopic();
  if (!topic || !googleConfigured(account)) return { ok: false, error: "not configured" };
  try {
    const r = await gfetch(`${BASE}/watch`, {
      method: "POST",
      body: JSON.stringify({ topicName: topic, labelIds: ["INBOX"], labelFilterAction: "include" }),
    }, account);
    if (!r.ok) {
      const error = `watch ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      await logEvent("gmail.watch.failed", { account, error }, { level: "warn" });
      return { ok: false, error };
    }
    const j = await r.json();
    const state = await loadStateFile();
    state[account] = { historyId: String(j.historyId), expiration: Number(j.expiration), lastRenewedAt: new Date().toISOString() };
    await saveStateFile(state);
    await logEvent("gmail.watch.started", { account, expiration: j.expiration });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// Renew watch for every connected account. Called daily by the scheduler.
export async function renewAllWatches(): Promise<string> {
  if (!gmailPushEnabled()) return "gmail push not configured (GMAIL_PUBSUB_TOPIC unset)";
  const results: string[] = [];
  for (const account of GOOGLE_ACCOUNTS) {
    if (!googleConfigured(account)) continue;
    const r = await startWatch(account);
    results.push(`${account}: ${r.ok ? "ok" : `failed (${r.error})`}`);
  }
  return results.length ? results.join(", ") : "no Google accounts connected";
}

// Cleanly stop push for an account (e.g. before disabling the feature). Not wired into any
// scheduled job — call manually if you ever need to tear it down.
export async function stopWatch(account: GoogleAccount): Promise<boolean> {
  try {
    const r = await gfetch(`${BASE}/stop`, { method: "POST" }, account);
    return r.ok;
  } catch { return false; }
}

export async function watchState(account: GoogleAccount): Promise<WatchState | undefined> {
  return (await loadStateFile())[account];
}
