// FRIDAY — inbound client attachment capture (owner ask 2026-07-19: client-experience).
//
// Before this, a client emailing "here's a screenshot of the bug" lost the screenshot entirely —
// gmail parsing read text/plain only. Now the attachment METADATA rides getMessageBody, and when a
// message actually carries a request, the allowlisted files are downloaded, filed into the client's
// Drive library ("Bug Reports"/"General" under the project, or a "From Client" folder when they have
// no project yet), and linked on the created task so the working agent can see them.
//
// Security posture: STORE-ONLY. Files are never executed, parsed, OCR'd, or fed to a model — bytes go
// straight to Drive. A tight mime allowlist + size/count caps bound what is ever downloaded; anything
// else is listed by name only. Filenames are sanitized before they touch task details or prompts, and
// prompts always frame them as data. Best-effort throughout: a Drive/fetch failure never blocks the
// reply. Kill switch FRIDAY_INBOUND_ATTACH=off.

import { logEvent } from "@/lib/persistence/store";
import type { Client, Project } from "@/lib/friday/types";
import type { InboundAttachment } from "@/lib/friday/google/gmail";

export const ATTACH_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024; // 8MB per file
export const ATTACH_MAX_COUNT = 5;               // per message

export function inboundAttachEnabled(): boolean {
  return (process.env.FRIDAY_INBOUND_ATTACH ?? "on").trim().toLowerCase() !== "off";
}

/** Neutralize path separators, control chars, and absurd length — the name lands in Drive + task details. */
export function sanitizeFilename(name: string): string {
  const cleaned = (name ?? "")
    .replace(/[\r\n\t\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "attachment";
}

/** Split metadata into what we will fetch (allowlisted, sized, capped) vs what stays name-only. */
export function eligibleAttachments(atts: InboundAttachment[]): { allowed: InboundAttachment[]; skipped: InboundAttachment[] } {
  const allowed: InboundAttachment[] = [];
  const skipped: InboundAttachment[] = [];
  for (const a of atts) {
    const mimeOk = ATTACH_ALLOWED_MIME.has((a.mimeType ?? "").toLowerCase().split(";")[0].trim());
    const sizeOk = a.sizeBytes > 0 && a.sizeBytes <= ATTACH_MAX_BYTES;
    if (mimeOk && sizeOk && allowed.length < ATTACH_MAX_COUNT) allowed.push(a);
    else skipped.push(a);
  }
  return { allowed, skipped };
}

export interface FiledAttachment { name: string; link?: string }

/**
 * Download the allowlisted attachments of one client message and file them into the client's Drive
 * library. Returns what was filed (with webViewLinks when Drive cooperated). Never throws.
 */
export async function captureClientAttachments(input: {
  msgId: string;
  account: "owner" | "friday";
  client: Client;
  project?: Project;
  bugish: boolean; // any extracted request of kind "bug" → file under "Bug Reports"
  attachments: InboundAttachment[];
}): Promise<FiledAttachment[]> {
  if (!inboundAttachEnabled() || !input.attachments.length) return [];
  const { allowed } = eligibleAttachments(input.attachments);
  const out: FiledAttachment[] = [];
  for (const a of allowed) {
    try {
      const { getAttachmentData } = await import("@/lib/friday/google/gmail");
      const bytes = await getAttachmentData(input.msgId, a.attachmentId, input.account);
      if (!bytes || bytes.length === 0 || bytes.length > ATTACH_MAX_BYTES) continue;
      const name = sanitizeFilename(a.filename);
      const mime = (a.mimeType ?? "application/octet-stream").split(";")[0].trim();
      let file: { webViewLink?: string } | null = null;
      if (input.project) {
        const { fileDeliverable } = await import("@/lib/friday/google/library");
        file = await fileDeliverable(input.client, input.project, input.bugish ? "Bug Reports" : "General", { name, bytes, mime });
      } else {
        const { ensureClientLibrary, FRIDAY_DRIVE_ID } = await import("@/lib/friday/google/library");
        const clientFolderId = await ensureClientLibrary(input.client);
        if (clientFolderId) {
          const { ensureFolder, uploadBinaryFile } = await import("@/lib/friday/google/drive");
          const folder = await ensureFolder("From Client", clientFolderId, FRIDAY_DRIVE_ID);
          if (folder?.id) file = await uploadBinaryFile(name, bytes, folder.id, mime);
        }
      }
      out.push({ name, link: file?.webViewLink });
      await logEvent("email.attachment_filed", { client: input.client.name, name, bytes: bytes.length, filed: !!file });
    } catch (e) {
      await logEvent("email.attachment_error", { client: input.client.name, name: a.filename.slice(0, 80), error: String(e).slice(0, 160) }, { level: "warn" });
    }
  }
  return out;
}

/** The "Client attachments:" block appended to task details (names + Drive links). */
export function attachmentsBlock(filed: FiledAttachment[]): string {
  if (!filed.length) return "";
  return `Client attachments:\n${filed.map((f) => `- ${f.name}${f.link ? ` — ${f.link}` : " (Drive filing failed — see original email)"}`).join("\n")}`;
}
