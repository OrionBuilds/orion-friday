import { NextRequest, NextResponse } from "next/server";
import { verifyInteragentSecret, type StatusRequest, type StatusResult } from "@autom8ionlab/agent-core";
import { store } from "@/lib/persistence/store";
import { config } from "@/lib/config";
import { lmStudioModels, lastBrainUsed, engineHealth, engineHealthDeep } from "@/lib/friday/engines";
import { isClosed } from "@/lib/friday/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mission-control overview: counts + which brains are online.
export async function GET() {
  const [clients, projects, tasks, agents, pending] = await Promise.all([
    store.clients.all(),
    store.projects.all(),
    store.tasks.all(),
    store.agents.all(),
    store.approvals.find((a) => a.status === "pending"),
  ]);
  const lmModels = await lmStudioModels();
  return NextResponse.json({
    counts: {
      clients: clients.length,
      projects: projects.length,
      activeProjects: projects.filter((p) => p.status === "active").length,
      tasks: tasks.length,
      openTasks: tasks.filter((t) => !isClosed(t.status)).length,
      agents: agents.filter((a) => a.active).length,
      pendingApprovals: pending.length,
    },
    brains: {
      claude: Boolean(config.claude),
      lmstudio: lmModels.length > 0,
      lmStudioModels: lmModels,
      last: lastBrainUsed(), // which brain served the most recent request (+ whether it was a fallback)
      engines: await engineHealth(), // every engine's configured state (claude/codex/antigravity/hermes/lmstudio)
      enginesDeep: await engineHealthDeep(), // real auth probe per engine {configured, authed, detail}
    },
    vault: Boolean(config.vaultRoot),
    owner: config.userName,
  });
}

// Structured project/portfolio status for sibling agents (CLARA's project_status tool, the Office).
// Interagent-gated; the shape is the shared StatusResponse so callers render it verbatim with
// provenance. Ambiguous or unknown subjects answer 200 with ok:false so the caller can ask "which one".
export async function POST(req: NextRequest) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<StatusRequest>;
  const subject = body.subject && typeof body.subject === "object" ? body.subject : undefined;
  if (!subject || !subject.type) return NextResponse.json({ ok: false, error: "subject required" } satisfies StatusResult, { status: 400 });
  const since = typeof body.since === "string" && !Number.isNaN(Date.parse(body.since)) ? body.since : undefined;
  const { resolveStatusSubject, buildProjectStatus, buildPortfolioStatus } = await import("@/lib/friday/statusReport");
  try {
    if (subject.type === "portfolio") return NextResponse.json(await buildPortfolioStatus(since) satisfies StatusResult);
    const r = await resolveStatusSubject(subject);
    if (!r) return NextResponse.json({ ok: false, error: "not found" } satisfies StatusResult);
    if ("candidates" in r) return NextResponse.json({ ok: false, error: "ambiguous", candidates: r.candidates } satisfies StatusResult);
    return NextResponse.json(await buildProjectStatus(r.project, since) satisfies StatusResult);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e).slice(0, 200) } satisfies StatusResult, { status: 500 });
  }
}
