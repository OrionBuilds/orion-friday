// FRIDAY — rebuild the local project registry from the Orion (Linux migration, 2026-09-12).
//
// The old machine's ~/.agentic-os/friday/projects.json did not come across, but the OS still holds
// project_agent_meta rows (agent='friday') whose local_project_id is the OLD local id of each project.
// projectsBridge maps local→OS by that id, so recreating each local project WITH the same id makes the
// existing mirror line up instead of pushing duplicates into the OS. Clients are an OS→local mirror
// already (contactsBridge); this script forces that refresh first so clientId can be resolved.
//
// Usage (FRIDAY must be OS-signed-in: ~/.agentic-os/friday/os-session.json present):
//   npx tsx scripts/friday/restore-projects-from-os.ts                 # dry run: prints the plan
//   npx tsx scripts/friday/restore-projects-from-os.ts --apply         # insert missing local projects
//   npx tsx scripts/friday/restore-projects-from-os.ts --apply --link  # ...and set workspaceDir where a folder matches
//   npx tsx scripts/friday/restore-projects-from-os.ts --link-only     # only set workspaceDir for existing local projects
// Folder matching: <FRIDAY_PROJECTS_ROOT>/marketing/<name> and <FRIDAY_PROJECTS_ROOT>/engineering/<name>,
// by a normalised name (lower-case, non-alphanumerics dropped). Anything ambiguous or unmatched is
// listed for a manual link (FRIDAY UI → project → workspace, or POST /api/friday/projects/workspace).

import { promises as fs } from "node:fs";
import path from "node:path";
import { store, nowISO } from "../../src/lib/persistence/store";
import { osClient, osEnabled } from "../../src/lib/friday/osClient";
import { refreshContacts } from "../../src/lib/friday/contactsBridge";
import type { Project, ProjectStatus } from "../../src/lib/friday/types";

// Root folder holding the project checkouts (FRIDAY_PROJECTS_ROOT, default ~/client-projects).
const PROJECTS_ROOT = process.env.FRIDAY_PROJECTS_ROOT || path.join(process.env.HOME || ".", "client-projects");
const FOLDER_GROUPS = ["marketing", "engineering"];
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const LINK = args.has("--link") || args.has("--link-only");
const LINK_ONLY = args.has("--link-only");

function unwrap(content: unknown): unknown {
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object" && "text" in (c as object));
    if (first && typeof (first as { text?: unknown }).text === "string") {
      try { return JSON.parse((first as { text: string }).text); } catch { return (first as { text: string }).text; }
    }
  }
  return content;
}
function rows(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") {
    for (const k of ["data", "projects", "rows", "items", "results"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return [];
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function osStatus(s: unknown): ProjectStatus {
  switch (String(s ?? "")) {
    case "on_hold": return "on_hold" as ProjectStatus;
    case "completed": return "completed" as ProjectStatus;
    case "cancelled": return "cancelled" as ProjectStatus;
    default: return "active" as ProjectStatus;
  }
}

async function folderIndex(): Promise<Map<string, string[]>> {
  const idx = new Map<string, string[]>();
  for (const g of FOLDER_GROUPS) {
    const dir = path.join(PROJECTS_ROOT, g);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      const full = path.join(dir, n);
      if (!(await fs.stat(full).catch(() => null))?.isDirectory()) continue;
      const key = norm(n);
      idx.set(key, [...(idx.get(key) ?? []), full]);
    }
  }
  return idx;
}
function proposeFolder(name: string, idx: Map<string, string[]>): { dir?: string; note: string } {
  const key = norm(name);
  const exact = idx.get(key);
  if (exact?.length === 1) return { dir: exact[0], note: "exact" };
  if (exact && exact.length > 1) return { note: `ambiguous: ${exact.join(", ")}` };
  const partial = [...idx.entries()].filter(([k]) => key.length >= 4 && (k.includes(key) || key.includes(k))).flatMap(([, v]) => v);
  if (partial.length === 1) return { dir: partial[0], note: "partial match — confirm" };
  if (partial.length > 1) return { note: `ambiguous: ${partial.join(", ")}` };
  return { note: "no folder found" };
}

async function main(): Promise<void> {
  if (!osEnabled()) {
    console.error("OS not connected: ~/.agentic-os/friday/os-session.json missing. Sign in at http://127.0.0.1:3737/api/os/auth first.");
    process.exit(2);
  }
  console.log(`mode: ${LINK_ONLY ? "link-only" : APPLY ? "apply" : "dry-run"}${LINK ? " +link" : ""}`);

  await refreshContacts(true);
  const clients = await store.clients.all();
  const byContact = new Map(clients.map((c) => [String((c as { osContactId?: string }).osContactId ?? ""), c]));
  console.log(`local clients after OS refresh: ${clients.length}`);

  const meta = rows(unwrap(await osClient.callTool("project_agent_meta_get", { agent: "friday" })));
  const osProjects = rows(unwrap(await osClient.callTool("projects_list", {})));
  const osById = new Map(osProjects.map((p) => [String(p.id), p]));
  console.log(`OS: ${meta.length} project_agent_meta rows for friday, ${osProjects.length} projects visible`);
  if (!meta.length) { console.log("sample projects_list row:", JSON.stringify(osProjects[0] ?? null).slice(0, 400)); }

  const existing = new Map((await store.projects.all()).map((p) => [p.id, p]));
  const idx = await folderIndex();
  const plan: string[] = [];
  let inserted = 0, linked = 0, skipped = 0;

  for (const m of meta) {
    const localId = m.local_project_id ? String(m.local_project_id) : "";
    const osId = String(m.project_id ?? "");
    const osp = osById.get(osId);
    if (!localId || !osp) { plan.push(`skip  os=${osId.slice(0, 8)} (no local_project_id or not visible in projects_list)`); skipped++; continue; }
    const name = String(osp.name ?? osp.title ?? `project ${osId.slice(0, 8)}`);
    let local = existing.get(localId) ?? null;

    if (!local && !LINK_ONLY) {
      const contactId = String(osp.contact_id ?? osp.client_id ?? "");
      const client = byContact.get(contactId);
      if (!client) { plan.push(`skip  ${name}: OS contact ${contactId.slice(0, 8) || "(none)"} has no local client mirror yet`); skipped++; continue; }
      const now = nowISO();
      const row: Project = {
        id: localId, clientId: client.id, name, status: osStatus(osp.status),
        description: typeof osp.description === "string" ? osp.description : undefined,
        deployUrl: typeof osp.website_url === "string" ? osp.website_url : typeof osp.deploy_url === "string" ? osp.deploy_url : undefined,
        createdAt: typeof osp.created_at === "string" ? osp.created_at : now, updatedAt: now,
      };
      plan.push(`${APPLY ? "insert" : "would insert"} ${name} → local ${localId.slice(0, 8)} (client ${client.name})`);
      if (APPLY) { local = await store.projects.insert(row); inserted++; }
    } else if (local) {
      plan.push(`have  ${name} (local ${localId.slice(0, 8)})`);
    }

    const { dir, note } = proposeFolder(name, idx);
    if (local?.workspaceDir) { plan.push(`      workspace already set: ${local.workspaceDir}`); continue; }
    if (dir) {
      plan.push(`      folder: ${dir} [${note}]${LINK && local && note === "exact" ? " → linking" : LINK && local ? " → NOT auto-linked (confirm manually)" : ""}`);
      if (LINK && local && note === "exact") { await store.projects.update(local.id, { workspaceDir: dir, updatedAt: nowISO() }); linked++; }
    } else {
      plan.push(`      folder: ${note}`);
    }
  }
  console.log(plan.join("\n"));
  console.log(`\nsummary: inserted ${inserted}, linked ${linked}, skipped ${skipped}, meta rows ${meta.length}`);
  if (!APPLY && !LINK_ONLY) console.log("dry run — re-run with --apply (and --link) to write.");
}

main().catch((e) => { console.error("restore failed:", e); process.exit(1); });
