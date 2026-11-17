// FRIDAY — escalation intelligence (Wave-3 #10). When a client asks for a human, the owner should
// arrive WARM: the critical handoff page now carries a full briefing in its email body — what
// triggered it, the whole account picture (projects, shipped, in-motion, open asks, approvals waiting),
// what FRIDAY did in the last 48h, remembered history, and exactly how to hand back. Store-reads only,
// no LLM — it must build in milliseconds on the escalation hot path and never delay the page.

import { store } from "@/lib/persistence/store";
import { buildBriefing } from "@/lib/friday/meetingPrep";
import type { Client, Escalation } from "@/lib/friday/types";

const H48 = 48 * 60 * 60 * 1000;

export async function buildEscalationBriefing(esc: Pick<Escalation, "channel" | "threadId" | "reason" | "createdAt">, client: Client): Promise<string> {
  // What FRIDAY touched for this client in the last 48h — the "what has already been tried" context
  // that turns a cold escalation into a 5-minute decision instead of a 20-minute archaeology dig.
  const cutoff = new Date(Date.now() - H48).toISOString();
  const projects = await store.projects.find((p) => p.clientId === client.id && p.status !== "archived");
  const projIds = new Set(projects.map((p) => p.id));
  const recent = (await store.tasks.find((t) => !!t.projectId && projIds.has(t.projectId) && (t.updatedAt ?? "") >= cutoff))
    .sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1))
    .slice(0, 8);

  const head = [
    `# 🙋 Handoff: ${client.name}`,
    ``,
    `**Trigger:** ${esc.reason || "asked for a human"} · via ${esc.channel}${esc.threadId ? " (thread-scoped)" : ""} · ${new Date(esc.createdAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
    `**FRIDAY's posture:** autonomous replies to ${client.name} are PAUSED${esc.threadId ? " on that thread" : ""} until you hand back.`,
    ``,
    recent.length
      ? `**Touched in the last 48h:**\n${recent.map((t) => `- [${t.status}] ${t.title.slice(0, 90)}`).join("\n")}`
      : `**Touched in the last 48h:** nothing — the account was quiet.`,
  ].join("\n");

  // The full account picture — same assembly the meeting-prep briefing uses, minus the call openers.
  const body = await buildBriefing(client, undefined, { openers: false });

  const foot = [
    ``,
    `**Your moves:**`,
    `- Reply to ${client.name.split(" ")[0]} directly — FRIDAY stays silent on them meanwhile.`,
    `- When done, text/say "resume ${client.name.split(" ")[0]}" and FRIDAY takes back over.`,
    `- Pending approvals above release from the dashboard or by replying to their approval emails.`,
  ].join("\n");

  return `${head}\n\n${body}\n${foot}`;
}
