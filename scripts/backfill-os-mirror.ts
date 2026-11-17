// One-shot backfill (2026-10-05): mirror OPEN client-request tasks that predate osMirror into the
// OS as change requests / support tickets, so the OS project tabs and the client portal show them.
//
//   node --experimental-transform-types --disable-warning=ExperimentalWarning \
//     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/test/register.mjs \
//     scripts/backfill-os-mirror.ts            # dry run: prints what would be created
//   ... scripts/backfill-os-mirror.ts --apply  # creates the rows
//
// Deliberately conservative — these rows are CLIENT-VISIBLE. Anything that reads as internal work
// (scheduler jobs, dependency bumps, the owner-only investigations, QA audits, parked items) is left out.

import { store } from "@/lib/persistence/store";
import type { Task } from "@/lib/friday/types";
import { mirrorTaskToOs, normalizeTitle, ROUND_TITLE, hasOsMarker, type IntakeKind } from "@/lib/friday/osMirror";

const apply = process.argv.includes("--apply");
// --include=<taskId,...> forces specific tasks past the conservative filter (still deduped/linked-checked).
const forced = new Set((process.argv.find((a) => a.startsWith("--include="))?.slice(10) ?? "").split(",").filter(Boolean));
const INTERNAL_TITLE = /^\s*(\[(deps|sales)\]|inspect\b|investigate\b|intake check\b|plan:|validate the fix|implement the minimal|reproduce and root-cause|monthly ai-search|weekly (on-site|lead))/i;
const EXCLUDED_ASSIGNEES = new Set(["human", "qa", "sales"]);
const CLOSED = new Set(["completed", "delivered", "on_hold"]);

export function eligible(t: Task): string | null {
  if (CLOSED.has(t.status)) return "closed/parked";
  if (!t.title?.trim()) return "no title";
  if (ROUND_TITLE.test(t.title)) return "round task";
  if (hasOsMarker(t)) return "already linked";
  if (t.origin === "os_ticket") return "portal-born";
  if (t.requestOrigin === "scheduler" || t.requestOrigin === "owner") return `origin ${t.requestOrigin}`;
  if (EXCLUDED_ASSIGNEES.has(t.assignee)) return `assignee ${t.assignee}`;
  if (INTERNAL_TITLE.test(t.title)) return "internal-looking title";
  return null;
}

function kindOf(t: Task): IntakeKind {
  const k = (t as Task & { requestKind?: string }).requestKind;
  if (k === "bug" || k === "feature" || k === "change" || k === "other") return k;
  return t.status === "bug_fixes" || /\b(bug|fix|broken|error|fails?)\b/i.test(t.title) ? "bug" : "feature";
}

async function main(): Promise<void> {
  const [tasks, projects, clients] = await Promise.all([store.tasks.all(), store.projects.all(), store.clients.all()]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const seen = new Map<string, Set<string>>(); // projectId → normalized titles already chosen / linked
  // Titles already linked to an OS row count as taken, so the backfill never duplicates them.
  for (const t of tasks) if (hasOsMarker(t)) {
    (seen.get(t.projectId) ?? seen.set(t.projectId, new Set()).get(t.projectId)!).add(normalizeTitle(t.title));
  }
  const picked: Task[] = [];
  const skipped = new Map<string, number>();
  for (const t of [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
    const project = projectById.get(t.projectId);
    const client = project?.clientId ? clientById.get(project.clientId) : undefined;
    const why = !project ? "no project" : !client || (client as { internal?: boolean }).internal ? "internal client" : forced.has(t.id) ? null : eligible(t);
    if (why) { skipped.set(why, (skipped.get(why) ?? 0) + 1); continue; }
    const set = seen.get(t.projectId) ?? seen.set(t.projectId, new Set()).get(t.projectId)!;
    const key = normalizeTitle(t.title);
    if (set.has(key)) { skipped.set("duplicate title", (skipped.get("duplicate title") ?? 0) + 1); continue; }
    set.add(key);
    picked.push(t);
  }

  const perProject = new Map<string, { cr: number; ticket: number; failed: number; titles: string[] }>();
  for (const t of picked) {
    const project = projectById.get(t.projectId)!;
    const client = clientById.get(project.clientId!)!;
    const kind = kindOf(t);
    const row = perProject.get(project.name) ?? { cr: 0, ticket: 0, failed: 0, titles: [] };
    perProject.set(project.name, row);
    row.titles.push(`${kind === "bug" ? "ticket" : "CR"} · ${t.status} · ${t.title.slice(0, 80)}`);
    if (!apply) { if (kind === "bug") row.ticket++; else row.cr++; continue; }
    const r = await mirrorTaskToOs({ task: t, project, kind, clientName: client.name, clientEmail: client.email || undefined, clientPhone: client.phone || undefined });
    if (r.ok) { if (r.table === "ticket") row.ticket++; else row.cr++; }
    else { row.failed++; console.log(`  ! ${project.name}: ${t.title.slice(0, 60)} — ${r.skipped}`); }
  }

  console.log(apply ? "APPLIED" : "DRY RUN (pass --apply to create rows)");
  for (const [name, r] of perProject) {
    console.log(`\n${name}: ${r.cr} change request(s), ${r.ticket} ticket(s)${r.failed ? `, ${r.failed} failed` : ""}`);
    for (const line of r.titles) console.log(`  - ${line}`);
  }
  console.log("\nskipped:", Object.fromEntries(skipped));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
