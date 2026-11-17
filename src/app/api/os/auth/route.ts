// One-time interactive sign-in for FRIDAY's Orion (OS MCP) access.
// GET /api/os/auth → bounce the browser to Supabase's Google OAuth. Supabase returns the session
// in the URL fragment to the capture page (see src/app/os/auth/capture), which POSTs it to
// /api/os/auth/callback. After that the vault has FRIDAY's refresh token and OS access is live.
import { osAuth } from "@/lib/friday/osClient";

export const runtime = "nodejs";

export async function GET() {
  return Response.redirect(osAuth.consentUrl(), 302);
}
