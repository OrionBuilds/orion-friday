// Meeting ingestion — turns client meeting transcripts/notes into planned work.
// For each recent meeting: FRIDAY identifies the client/project, extracts action items with
// suggested agents, creates tasks, and files the transcript to the client's Obsidian folder
// (+ Drive when connected). Deduped per meeting so re-runs don't double up.

import { promises as fs } from "node:fs";
import path from "node:path";
import { FRIDAY_DATA_DIR, store, nowISO, logEvent } from "@/lib/persistence/store";
import { complete, completeJSON, defaultEngine } from "@/lib/friday/engines";
import { listClients, listProjects, createTask } from "@/lib/friday/repo";
import { DEFAULT_STAGE } from "@/lib/friday/stages";
import { resolveAssignee } from "@/lib/friday/agents";
import { appendProjectLog } from "@/lib/persistence/obsidian";
import { listRecentMeetings } from "@/lib/friday/google/meet";
import { googleConfigured } from "@/lib/friday/google/auth";
import { uploadTextFile } from "@/lib/friday/google/drive";
import { dial } from "@/lib/friday/dials";
import { AGENCY } from "@/lib/friday/persona";

const SEEN_FILE = path.join(FRIDAY_DATA_DIR, "ingested-meetings.json");

async function seen(): Promise<Set<string>> {
  try { return new Set(JSON.parse(await fs.readFile(SEEN_FILE, "utf8"))); } catch { return new Set(); }
}
async function markSeen(ids: Set<string>): Promise<void> {
  try { await fs.writeFile(SEEN_FILE, JSON.stringify([...ids])); } catch { /* ignore */ }
}

interface Extract {
  clientName: string | null;
  projectName: string | null;
  summary: string;
  tasks: { title: string; assignee: string }[];
}

export interface IngestResult { meetings: number; tasksCreated: number; items: { client: string; project: string; tasks: number; summary: string }[]; }

export async function ingestMeetings(days = 7): Promise<IngestResult> {
  const result: IngestResult = { meetings: 0, tasksCreated: 0, items: [] };
  if (!googleConfigured()) return result;

  const meetings = await listRecentMeetings(days);
  const seenIds = await seen();
  const clients = await listClients();
  const projects = await store.projects.all();
  const roster = `Clients & projects:\n${clients.map((c) => `- ${c.name}: ${projects.filter((p) => p.clientId === c.id).map((p) => p.name).join(", ") || "(no projects)"}`).join("\n")}`;

  for (const m of meetings) {
    if (seenIds.has(m.conferenceRecord)) continue;
    seenIds.add(m.conferenceRecord);

    const ex = await completeJSON<Extract>({
      engine: defaultEngine(),
      system: `You are FRIDAY, planning from a client meeting transcript. ${roster}\n\nRead the transcript and respond with ONLY JSON:
{ "clientName": "the client this is about, or null", "projectName": "the project, or null",
  "summary": "3-5 sentence summary of decisions + context",
  "tasks": [ { "title": "concrete action item", "assignee": "architect|dev|devops|qa|debug|automation|pm|support|research" } ] }
Only include real action items that came out of the meeting.`,
      prompt: `Participants: ${m.participants.join(", ") || "unknown"}\nTranscript:\n${m.text.slice(0, 12000)}`,
      timeoutMs: 120_000,
    });
    if (!ex) { await markSeen(seenIds); continue; }
    result.meetings++;

    // match to a client/project
    const client = ex.clientName ? clients.find((c) => c.name.toLowerCase().includes(ex.clientName!.toLowerCase()) || ex.clientName!.toLowerCase().includes(c.name.toLowerCase())) : null;
    const clientProjects = client ? projects.filter((p) => p.clientId === client.id) : [];
    const project =
      (ex.projectName && clientProjects.find((p) => p.name.toLowerCase().includes(ex.projectName!.toLowerCase()))) ||
      clientProjects.find((p) => p.status === "active") ||
      clientProjects[0];

    let made = 0;
    if (project) {
      for (const t of (ex.tasks ?? []).slice(0, 12)) {
        await createTask({ projectId: project.id, title: t.title, assignee: resolveAssignee(t.assignee), status: DEFAULT_STAGE, risk: "low", description: `From meeting on ${m.startTime}.`, requestedBy: client?.name ?? undefined, requesterClientId: client?.id, requestOrigin: "scheduler" });
        made++;
      }
      await appendProjectLog(project, { actor: "FRIDAY", kind: "meeting", text: `🎙️ **Meeting ingested** (${m.startTime})\n${ex.summary}\n\n${(ex.tasks ?? []).map((t) => `- [ ] ${t.title} _(${t.assignee})_`).join("\n")}` });
      // File the transcript + summary into the project's "Meeting Notes" library folder (best-effort).
      if (client) {
        try {
          const { ensureCategoryFolder } = await import("@/lib/friday/google/library");
          const folderId = await ensureCategoryFolder(client, project, "Meeting Notes");
          if (folderId) await uploadTextFile(`Meeting ${m.startTime.slice(0, 10)} — summary.txt`, `SUMMARY\n${ex.summary}\n\nACTION ITEMS\n${(ex.tasks ?? []).map((t) => `- ${t.title} (${t.assignee})`).join("\n")}\n\nTRANSCRIPT\n${m.text.slice(0, 40000)}`, folderId);
        } catch { /* ignore */ }
      }
      // Institutional memory: index the transcript summary + body (the richest client corpus, which
      // otherwise only lands in Drive/Obsidian) so FRIDAY can recall what was said on the call.
      const { indexMemory } = await import("@/lib/friday/memory");
      void indexMemory({ id: `meet:${m.conferenceRecord}`, kind: "transcript", text: `${ex.summary}\n\n${m.text.slice(0, 1800)}`, clientId: client?.id, projectId: project.id, ts: m.startTime }).catch(() => {});
      result.tasksCreated += made;
      result.items.push({ client: client?.name ?? "Unassigned", project: project.name, tasks: made, summary: ex.summary });
      await logEvent("meeting.ingest", { client: client?.name, project: project.name, tasks: made }, { projectId: project.id });

      // Meeting follow-up draft (Wave-2 #5, the AFTER half): a warm same-day recap + next-steps email
      // to the client, drafted from the extraction and parked in the EXISTING approve-to-send loop
      // (email replies are a hard Tier-3 floor — the owner always releases it). Best-effort.
      // Gated on made > 0 (Wave-1): a transcript that yielded zero action items has nothing to
      // recap — drafting anyway was queuing empty follow-up approvals per re-run.
      if (client?.email && made > 0 && dial("meeting_followups") !== "off") {
        try {
          const first = client.name.trim().split(/\s+/)[0] || "there";
          const followUp = (await complete({
            system:
              `You are FRIDAY, Technical Director at ${AGENCY}, writing a same-day follow-up email after a client call — 90 to 150 words, warm plain English. ` +
              "Rules: recap ONLY what the summary/action items say; never invent dates, prices, or commitments beyond them; no internal jargon or agent names; 2 short paragraphs; sign off as FRIDAY. Output the email BODY only.",
            prompt: `Client first name: ${first}\nCall summary: ${ex.summary}\nAction items we took away:\n${(ex.tasks ?? []).map((t) => `- ${t.title}`).join("\n") || "- (none — recap only)"}\n\nWrite the email body now.`,
            temperature: 0.5, timeoutMs: 90_000,
          })).trim();
          const { weeklyUpdateIssues } = await import("@/lib/friday/weeklyUpdate");
          const qaIssues = weeklyUpdateIssues(followUp);
          // Drafted into the owner's approval queue in the OS (Clara sends after approval). The per-meeting
          // external ref makes a reprocessed meeting (crash mid-batch, seen-file race) a no-op.
          const { queueClientEmail } = await import("@/lib/friday/osClientEmail");
          const draft = await queueClientEmail(client, {
            subject: "Great talking today — recap + next steps", body: followUp,
            ref: `meet:${m.conferenceRecord}`, summary: `Meeting follow-up${qaIssues.length ? ` (QA: ${qaIssues.join(" · ").slice(0, 100)})` : ""}`,
          });
          if (draft.ok) {
            await logEvent("meeting.followup_queued", { client: client.name, qaIssues: qaIssues.length }, { projectId: project.id });
          }
        } catch (e) {
          await logEvent("meeting.followup_error", { error: String(e).slice(0, 160) }, { level: "warn", projectId: project.id }).catch(() => {});
        }
      }
    }
    // Persist the seen-file after EACH meeting (Wave-1), not once after the loop — a crash
    // mid-batch used to reprocess every earlier meeting on the next sweep (duplicate tasks +
    // duplicate follow-up approvals; see the dedupeRef guard above for the in-flight one).
    await markSeen(seenIds);
  }

  return result;
}
