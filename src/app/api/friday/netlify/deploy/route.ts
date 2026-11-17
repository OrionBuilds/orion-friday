import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { queueDeployApproval } from "@/lib/friday/orchestrator";
import { shortCode } from "@/lib/friday/risk";
import { findNetlifySite, latestNetlifyDeploys, netlifySiteSettings, purgeNetlifyCache } from "@/lib/friday/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?projectId=… → latest deploy states for the project's Netlify site (to verify a deploy landed).
export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  const project = projectId ? await store.projects.get(projectId) : null;
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  let siteId = project.netlifySiteId;
  if (!siteId) {
    const site = await findNetlifySite(project.deployUrl || project.name);
    siteId = site?.id;
  }
  if (!siteId) return NextResponse.json({ error: "Netlify site not resolvable" }, { status: 400 });
  const [deploys, settings] = await Promise.all([latestNetlifyDeploys(siteId), netlifySiteSettings(siteId)]);
  return NextResponse.json({ siteId, deploys, settings });
}

// Trigger a Netlify production build for a project — in-process, using NETLIFY_AUTH_TOKEN.
// { projectId, clearCache?: boolean }. clearCache=true forces a cache-clearing rebuild (the only
// reliable way to evict stale user-agent-keyed CDN entries).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const clearCache = body.clearCache === true;
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const project = await store.projects.get(projectId);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // purgeOnly: evict cached responses without triggering a rebuild (fast — for clearing stale
  // user-agent-keyed prerender variants when the current build is already correct).
  if (body.purgeOnly === true) {
    let siteId = project.netlifySiteId;
    if (!siteId) { const s = await findNetlifySite(project.deployUrl || project.name); siteId = s?.id; }
    if (!siteId) return NextResponse.json({ error: "Netlify site not resolvable" }, { status: 400 });
    const cacheTags = Array.isArray(body.cacheTags) ? body.cacheTags.map(String) : undefined;
    const p = await purgeNetlifyCache(siteId, { cacheTags });
    return NextResponse.json({ ok: p.ok, purged: p.ok, error: p.error, siteId, cacheTags });
  }

  // The build only fires through decideApproval (→ deployNetlify). A dashboard click is the owner
  // asking (origin "owner"): under ACTIVE origin-aware authority queueDeployApproval takes the approve
  // click itself and the build is already triggered by the time it returns; otherwise the row waits.
  const approval = await queueDeployApproval(project, { clearCache, origin: "owner" });
  const pending = approval.status === "pending";
  return NextResponse.json({
    ok: true,
    pending,
    approvalId: approval.id,
    code: shortCode(approval.id),
    message: pending
      ? `Deploy of ${project.name} queued for approval — reply "approve" to the approval email or use the dashboard. Nothing ships until then.`
      : `Deploy of ${project.name} triggered (owner-origin, auto-approved)${approval.resultNote ? ` — ${approval.resultNote.slice(0, 160)}` : ""}.`,
  });
}
