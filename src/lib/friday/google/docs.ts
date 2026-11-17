// Google Docs — editable deliverables (proposals, SOWs, status reports) as a shareable Doc, an
// alternative to the PDF. Needs the `documents` scope (added to GOOGLE_SCOPES) + one re-consent.
import { gfetch, type GoogleAccount } from "./auth";

const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3";

// Create a Doc with the given title + body text, return its share URL. (Body is inserted as plain
// text — markdown stays readable; rich styling can come later.)
//
// `account` defaults to "owner" so the orchestrator's existing deliverable pipeline is unchanged.
// Pass "friday" to create in FRIDAY's OWN Drive instead — which is what the conversational
// create_doc tool does: a doc she was asked to write is hers to hold, and it keeps her out of
// The owner's Drive for anything they didn't explicitly route through the deliverable pipeline.
export async function createDoc(title: string, content: string, account: GoogleAccount = "owner"): Promise<{ ok: boolean; id?: string; url?: string; error?: string }> {
  const r = await gfetch(DOCS, { method: "POST", body: JSON.stringify({ title }) }, account);
  if (!r.ok) return { ok: false, error: `docs create ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  const id = j.documentId as string;
  if (content?.trim()) {
    await gfetch(`${DOCS}/${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content.slice(0, 90_000) } }] }),
    }, account).catch(() => {});
  }
  return { ok: true, id, url: `https://docs.google.com/document/d/${id}/edit` };
}

// Share a Doc with someone (default read-only) via Drive permissions. `account` defaults to
// "owner" so the orchestrator's deliverable pipeline is unchanged; pass "friday" for docs that
// live in FRIDAY's own Drive (everything the conversational create_doc tool makes).
export async function shareDoc(id: string, email: string, role: "reader" | "writer" | "commenter" = "reader", account: GoogleAccount = "owner"): Promise<{ ok: boolean; error?: string }> {
  const r = await gfetch(`${DRIVE}/files/${id}/permissions?sendNotificationEmail=false`, {
    method: "POST", body: JSON.stringify({ role, type: "user", emailAddress: email }),
  }, account);
  return r.ok ? { ok: true } : { ok: false, error: `share ${r.status}` };
}

// Reverse gear for shareDoc (plan §7.4): remove a person's access again. Looks the permission up
// by email and deletes it — the file itself is untouched.
export async function unshareDoc(id: string, email: string, account: GoogleAccount = "owner"): Promise<{ ok: boolean; error?: string }> {
  const list = await gfetch(`${DRIVE}/files/${id}/permissions?fields=permissions(id,type,emailAddress)`, {}, account);
  if (!list.ok) return { ok: false, error: `permissions list ${list.status}` };
  const j = (await list.json()) as { permissions?: Array<{ id: string; type?: string; emailAddress?: string }> };
  const hit = (j.permissions ?? []).find((p) => p.type === "user" && p.emailAddress?.toLowerCase() === email.toLowerCase());
  if (!hit) return { ok: false, error: `no permission for ${email} on this doc` };
  const r = await gfetch(`${DRIVE}/files/${id}/permissions/${hit.id}`, { method: "DELETE" }, account);
  return r.ok ? { ok: true } : { ok: false, error: `unshare ${r.status}` };
}
