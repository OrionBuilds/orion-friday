import { NextResponse } from "next/server";
import { store } from "@/lib/persistence/store";
import { getLive } from "@/lib/fridayLive";
import { isLive } from "@/lib/ultracodeProcs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Agent run history (with results + artifacts) for a project or a single task.
// Backs the project board's per-task result panel.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const taskId = url.searchParams.get("taskId");
  const status = url.searchParams.get("status");

  // Control Room: running (or recent) runs across ALL projects, enriched with task/project labels +
  // the live headline. Handled before the projectId/taskId guard.
  if (status) {
    const wantRunning = status === "running";
    // A run counts as "running" only if it's genuinely live on THIS server (registered child) or was
    // started recently — this drops orphaned runs left "running" in runs.json by a prior server boot.
    const RECENT = 20 * 60_000;
    let runs = await store.runs.find((r) => {
      if (!wantRunning) return true;
      if (r.status !== "running") return false;
      return isLive(r.id) || Date.now() - new Date(r.startedAt).getTime() < RECENT;
    });
    runs = runs.sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1)).slice(0, wantRunning ? 50 : 30);
    const [tasks, projects, agents] = await Promise.all([store.tasks.all(), store.projects.all(), store.agents.all()]);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const projById = new Map(projects.map((p) => [p.id, p]));
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const enriched = runs.map((r) => {
      const t = r.taskId ? taskById.get(r.taskId) : undefined;
      const p = r.projectId ? projById.get(r.projectId) : undefined;
      const ag = agentById.get(r.agentId);
      const live = getLive(r.id);
      return {
        id: r.id, agentId: r.agentId, agentName: ag?.name ?? r.agentId, role: ag?.role ?? r.agentId,
        engine: live?.engine ?? r.intendedEngine ?? ag?.engine,
        taskTitle: t?.title ?? r.input, projectName: p?.name, projectId: r.projectId,
        status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
        headline: live?.headline ?? r.live?.headline,
        bugCount: live?.bugCount ?? r.live?.bugCount, checking: live?.checking ?? r.live?.checking,
        actionsCount: live?.actions.length ?? r.live?.actionsCount, tokens: live?.tokens ?? r.live?.tokens,
      };
    });
    return NextResponse.json({ runs: enriched });
  }

  if (!projectId && !taskId) return NextResponse.json({ error: "projectId or taskId required" }, { status: 400 });
  let runs = await store.runs.find((r) => (taskId ? r.taskId === taskId : r.projectId === projectId));
  // newest first
  runs = runs.sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1));
  return NextResponse.json({ runs });
}
