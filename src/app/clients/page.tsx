// M4 — this module now lives in the OS. Clients/projects are OS records since M1/M2
// (see lib/*/contactsBridge.ts); this page is a redirect so stale bookmarks land somewhere
// useful. The app's own APIs under /api remain fully functional for the agent runtime.
import { redirect } from "next/navigation";

// The OS address is config (ORION_PUBLIC_URL; OS_PUBLIC_URL is the older alias) — no hardcoded
// hostname (2026-10-28 audit; public-template rule). Unset ⇒ say so rather than redirect
// somewhere wrong. Read per request, not baked in at build time.
export const dynamic = "force-dynamic";

export default function Page() {
  const base = (process.env.ORION_PUBLIC_URL ?? process.env.OS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (base) redirect(`${base}/contacts`);
  return <p style={{ padding: 24 }}>This module now lives in the OS. Set ORION_PUBLIC_URL to link to it from here.</p>;
}
