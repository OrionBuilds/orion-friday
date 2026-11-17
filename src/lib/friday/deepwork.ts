// FRIDAY's deep-work wrapper — same contract as the sibling agents' deep-work wrappers: fire-and-forget
// around agent-core's runDeepWork, owning delivery (shared-drive upload) and notification (links +
// NEEDS YOUR ATTENTION items to the owner, completion appended to the web thread). Deliverables land in
// Drive ONLY, per the owner's 2026-08-13 decisions.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runDeepWork } from "@autom8ionlab/agent-core";
import { ensureFolder, uploadBinaryFile } from "@/lib/friday/google/drive";
import { FRIDAY_DRIVE_ID } from "@/lib/friday/google/library";
import { notifyOwner } from "@/lib/friday/notify";
import { store, newId, nowISO, FRIDAY_DATA_DIR } from "@/lib/persistence/store";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function attentionItems(summary: string): string {
  const m = summary.match(/NEEDS YOUR ATTENTION:?\s*([\s\S]*)$/i);
  return m ? m[1].trim().slice(0, 900) : "";
}

export function startDeepWork(task: string, opts: { clientName?: string } = {}): { started: true; line: string } {
  void (async () => {
    const startedAt = Date.now();
    const result = await runDeepWork({
      agent: "friday",
      dataDir: FRIDAY_DATA_DIR,
      task,
      client: opts.clientName,
    });

    const links: string[] = [];
    let folderNote = "";
    try {
      const deepFolder = await ensureFolder("Deep Work", FRIDAY_DRIVE_ID, FRIDAY_DRIVE_ID);
      const dated = deepFolder ? await ensureFolder(new Date().toISOString().slice(0, 10), deepFolder.id, FRIDAY_DRIVE_ID) : null;
      const destId = dated?.id ?? deepFolder?.id;
      if (destId) {
        for (const f of result.files) {
          const bytes = await fs.readFile(f.path).catch(() => null);
          if (!bytes) continue;
          const mime = MIME[path.extname(f.name).toLowerCase()] ?? "application/octet-stream";
          const up = await uploadBinaryFile(f.name, bytes, destId, mime);
          if (up?.webViewLink) links.push(`${f.name}: ${up.webViewLink}`);
        }
        folderNote = dated?.webViewLink ?? deepFolder?.webViewLink ?? "";
      }
    } catch { /* degrade to workspace-path mention below */ }

    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    const attention = attentionItems(result.summary);
    const text = result.ok
      ? [
          `Deep work done (${mins} min): ${task.slice(0, 120)}`,
          links.length ? `Files in Drive:\n${links.join("\n")}` : `Produced ${result.files.length} file(s) — Drive upload failed, they're in ${result.workspace}\\output`,
          folderNote ? `Folder: ${folderNote}` : "",
          attention && !/^none\.?$/i.test(attention) ? `NEEDS YOUR ATTENTION:\n${attention}` : "",
        ].filter(Boolean).join("\n\n")
      : `Deep work FAILED (${mins} min): ${task.slice(0, 120)} — ${result.error ?? "unknown"}. ${result.files.length ? `Partial files in ${result.workspace}\\output.` : "Nothing was produced."}`;

    await notifyOwner({ kind: "deepwork.done", text, priority: result.ok ? "normal" : "critical", subject: `FRIDAY deep work ${result.ok ? "done" : "failed"}` }).catch(() => {});
    await store.messages.append({ id: newId(), channel: "web", role: "friday", text, ts: nowISO() }).catch(() => {});
  })();

  return {
    started: true,
    line: "deep_work: started — this is a real build (research, documents, review), so it'll take a while. I'll ping you with the Drive links and anything that needs your call when it's done.",
  };
}
