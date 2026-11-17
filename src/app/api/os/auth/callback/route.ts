// Receives {access_token, refresh_token} from the client-side capture page (the tokens arrive in a
// URL fragment that never reaches the server, so the browser forwards them here). captureSession
// verifies the identity via Supabase /auth/v1/user before persisting to FRIDAY's vault.
import { osAuth } from "@/lib/friday/osClient";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    return Response.json({ ok: false, error: "missing access_token/refresh_token" }, { status: 400 });
  }
  const res = await osAuth.captureSession(body.access_token, body.refresh_token);
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

// Quick status probe for a settings page / connect button.
export async function GET() {
  return Response.json({ configured: osAuth.osConfigured(), identity: osAuth.osIdentity() });
}
