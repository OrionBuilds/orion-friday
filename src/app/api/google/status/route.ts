import { NextResponse } from "next/server";
import { googleClient, refreshToken, getAccessToken, GOOGLE_ACCOUNTS, type GoogleAccount } from "@/lib/friday/google/auth";
import { getSignature } from "@/lib/friday/google/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function accountStatus(account: GoogleAccount): Promise<{ hasToken: boolean; connected: boolean; email: string | null; signature: boolean; signatureChars: number; signaturePreview: string }> {
  const hasToken = Boolean(refreshToken(account));
  let connected = false, email: string | null = null, sig = "";
  if (hasToken) {
    try {
      const token = await getAccessToken(account);
      const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { connected = true; email = (await r.json()).email ?? null; }
    } catch { /* not connected */ }
    // Whether this account's Gmail signature is readable (API-sent mail only carries it if we append it).
    if (connected) { try { sig = await getSignature(account, true); } catch { /* ignore */ } }
  }
  // A short plain-text preview so the operator can SEE which signature is attached to which account.
  // Readable preview. Signatures are often a single image (no text at all), so say so rather than
  // showing an empty string and looking broken.
  const text = sig.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  const img = sig.match(/<img[^>]*width="(\d+)"[^>]*height="(\d+)"/i) ?? sig.match(/<img/i);
  const preview = text ? text.slice(0, 120)
    : img ? `(image signature${img[1] ? ` ${img[1]}x${img[2]}` : ""})`
    : "";
  return { hasToken, connected, email, signature: sig.length > 0, signatureChars: sig.length, signaturePreview: preview };
}

export async function GET() {
  const clientConfigured = Boolean(googleClient());
  const accounts: Record<string, { hasToken: boolean; connected: boolean; email: string | null; signature: boolean; signatureChars: number; signaturePreview: string }> = {};
  if (clientConfigured) {
    for (const a of GOOGLE_ACCOUNTS) accounts[a] = await accountStatus(a);
  } else {
    for (const a of GOOGLE_ACCOUNTS) accounts[a] = { hasToken: false, connected: false, email: null, signature: false, signatureChars: 0, signaturePreview: "" };
  }
  // Back-compat top-level fields mirror the owner account (existing UI/consumers read these).
  return NextResponse.json({
    clientConfigured,
    hasToken: accounts.owner.hasToken,
    connected: accounts.owner.connected,
    email: accounts.owner.email,
    accounts,
  });
}
