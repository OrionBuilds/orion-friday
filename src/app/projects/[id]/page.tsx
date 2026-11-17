// M4 — projects live in the OS Projects module (M2). This board's data is mirrored there;
// deep-linking by OS project id isn't resolvable locally (the id map lives OS-side in
// project_agent_meta), so land on the module list.
import { redirect } from "next/navigation";

// The OS address is config (ORION_PUBLIC_URL; OS_PUBLIC_URL is the older alias) — no hardcoded
// hostname (2026-10-28 audit; public-template rule). Unset ⇒ say so rather than redirect
// somewhere wrong. Read per request, not baked in at build time.
export const dynamic = "force-dynamic";

export default function Page() {
  const base = (process.env.ORION_PUBLIC_URL ?? process.env.OS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (base) redirect(`${base}/projects`);
  return <p style={{ padding: 24 }}>This module now lives in the OS. Set ORION_PUBLIC_URL to link to it from here.</p>;
}
