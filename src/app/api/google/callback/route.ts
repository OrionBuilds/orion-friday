import { NextResponse } from "next/server";
import { exchangeCode, type GoogleAccount } from "@/lib/friday/google/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Google redirects here with ?code=… (&state=owner|friday) — exchange it for a refresh token stored in
// the account slot from `state`, then bounce home.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const account: GoogleAccount = url.searchParams.get("state") === "friday" ? "friday" : "owner";
  if (error) return NextResponse.redirect(new URL(`/settings?google=error&reason=${encodeURIComponent(error)}`, url.origin));
  if (!code) return NextResponse.redirect(new URL("/settings?google=error&reason=no_code", url.origin));
  const res = await exchangeCode(code, account);
  return NextResponse.redirect(new URL(res.ok ? `/settings?google=connected&account=${account}` : `/settings?google=error&reason=${encodeURIComponent(res.error ?? "exchange_failed")}`, url.origin));
}
