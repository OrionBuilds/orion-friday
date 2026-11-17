import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { store, logEvent } from "@/lib/persistence/store";
import { withinArtifacts } from "@/lib/friday/artifacts";
import { sendClientEmail } from "@/lib/friday/emailAgent";
import { googleConfigured } from "@/lib/friday/google/auth";
import { AGENCY } from "@/lib/friday/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-triggered: email a run's PDF report to the client (or an override recipient) from the
// owner's own Gmail. The UI confirms before calling this — an outward client send is never
// automatic. Body: { runId, to?, subject?, note? }.
export async function POST(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.json({ error: "Google/Gmail not connected — connect it in Settings first." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const runId = String(body.runId ?? "");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const run = await store.runs.get(runId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  const pdf = (run.artifacts ?? []).find((a) => a.kind === "pdf" && a.path);
  if (!pdf?.path) return NextResponse.json({ error: "this run has no PDF report to send" }, { status: 400 });
  if (!withinArtifacts(path.resolve(pdf.path)) || !existsSync(pdf.path)) {
    return NextResponse.json({ error: "report file missing" }, { status: 404 });
  }

  const project = run.projectId ? await store.projects.get(run.projectId) : null;
  const client = project ? await store.clients.get(project.clientId) : null;
  const to = String(body.to ?? client?.email ?? "").trim();
  if (!to) return NextResponse.json({ error: "no recipient — the client has no email on file (pass `to`)" }, { status: 400 });

  const subject = String(body.subject ?? `${project?.name ?? AGENCY} — ${pdf.label}`);
  // No manual sign-off — FRIDAY's Gmail signature is appended by sendEmail (see gmail.getSignature).
  const note = String(body.note ?? `Hi${client?.name ? ` ${client.name.split(" ")[0]}` : ""},\n\nPlease find attached the ${pdf.label} for ${project?.name ?? "your project"}.\n\nBest,`);
  const bytes = await readFile(pdf.path);

  // Send from FRIDAY's account (owner CC'd) so all client email comes from her; falls back to owner if she isn't connected.
  const res = await sendClientEmail({
    to, subject, body: note,
    attachments: [{ filename: path.basename(pdf.path), mime: pdf.mime ?? "application/pdf", content: bytes }],
  });
  await logEvent("deliver.email", { to, subject, ok: res.ok, from: res.account, runId }, { projectId: run.projectId, level: res.ok ? "info" : "warn" });
  if (!res.ok) return NextResponse.json({ error: res.error ?? "send failed" }, { status: 502 });
  return NextResponse.json({ ok: true, id: res.id, to });
}
