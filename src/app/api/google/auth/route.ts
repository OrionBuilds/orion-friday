import { NextResponse } from "next/server";
import { consentUrl, type GoogleAccount } from "@/lib/friday/google/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kick off Google consent — redirects the browser to Google's OAuth screen. ?account=owner|friday
// selects which account slot the resulting token is stored in (default owner).
export async function GET(req: Request) {
  const account: GoogleAccount = new URL(req.url).searchParams.get("account") === "friday" ? "friday" : "owner";
  const url = consentUrl(account);
  if (!url) return NextResponse.json({ error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first." }, { status: 400 });
  return NextResponse.redirect(url);
}
