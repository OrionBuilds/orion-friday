// Gmail — send + read for client communication. Account-aware: pass `account` to read/send as the
// owner (default) or FRIDAY's own workspace account. Gmail sends "from" whichever account's token is
// used (via users/me), so selecting the account IS selecting the sender.
import { randomUUID } from "node:crypto";
import { gfetch, type GoogleAccount } from "./auth";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// base64url of a Buffer (Gmail's raw message encoding).
function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// standard base64, wrapped at 76 cols per RFC 2045 (for MIME attachment bodies).
function b64wrap(b: Buffer): string {
  return b.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

export interface EmailAttachment { filename: string; mime: string; content: Buffer }

// ── Signature ───────────────────────────────────────────────────────────────
// A Gmail signature configured in the account's settings is applied by the Gmail WEB UI ONLY. The API
// sends exactly the MIME we hand it, so an API-sent mail NEVER carries the signature unless we fetch
// it from settings and append it ourselves. That's what this does — using the SENDING account's own
// signature, so FRIDAY's mail carries FRIDAY's signature.
const sigCache = new Map<GoogleAccount, { html: string; at: number }>();
const SIG_TTL = 10 * 60_000;

export async function getSignature(account: GoogleAccount = "owner", force = false): Promise<string> {
  const hit = sigCache.get(account);
  if (!force && hit && Date.now() - hit.at < SIG_TTL) return hit.html;
  try {
    const r = await gfetch(`${BASE}/settings/sendAs`, {}, account);
    if (!r.ok) { sigCache.set(account, { html: "", at: Date.now() }); return ""; }
    const j = await r.json();
    const list: { isPrimary?: boolean; isDefault?: boolean; signature?: string }[] = j.sendAs ?? [];
    // Prefer the default send-as identity, then the primary address.
    const pick = list.find((s) => s.isDefault && s.signature) ?? list.find((s) => s.isPrimary) ?? list[0];
    const html = (pick?.signature ?? "").trim();
    sigCache.set(account, { html, at: Date.now() });
    return html;
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Plain body -> HTML for the text/html alternative (preserve the agent's line breaks).
function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}
// Crude HTML -> text so the text/plain alternative still shows a signature for plain-text clients.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// RFC 2047 encode a header value when it contains anything outside US-ASCII.
//
// Header bytes are ASCII by definition, so a raw UTF-8 subject is decoded by the recipient's client
// as latin-1 and an em-dash arrives as "Ã¢Â€Â”". Seen live on 2026-08-03 in a PR-review mail sent to
// a colleague. Pure-ASCII subjects are passed through untouched so the common case stays readable
// in raw MIME.
function encodeHeaderWord(value: string): string {
  if (!value) return "";
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// Build the raw base64url MIME for a message, appending the sending account's Gmail signature.
// Shapes: text/plain | multipart/alternative | multipart/mixed[ text/plain , atts ]
//         | multipart/mixed[ multipart/alternative[plain,html] , atts ]
async function buildRaw(input: {
  to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string;
  attachments?: EmailAttachment[]; agent?: string;
  // Optional caller-supplied text/html alternative (branded templated sends — weekly update, review,
  // welcome). `body` stays the plain-text source of truth; the signature is appended to BOTH parts.
  html?: string;
}, account: GoogleAccount): Promise<string> {
  const atts = input.attachments ?? [];
  const sig = await getSignature(account);
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : "",
    `Subject: ${encodeHeaderWord(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : "",
    input.references ? `References: ${input.references}` : "",
    // X-Agent marks this as machine mail from an agent rather than a person. FRIDAY's own owner
    // notifications land in the owner inbox that FRIDAY POLLS — without this she can read her own
    // approval requests back as client email and answer them. isAgentMail() catches the self-
    // addressed case too, but the stamp is the explicit signal. Mirrors the sibling agents' `agent` param.
    input.agent ? `X-Agent: ${input.agent}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const plain = sig ? `${input.body}\n\n${htmlToText(sig)}` : input.body;
  // Caller HTML wins (already rendered + escaped upstream); else the signature alone forces the
  // classic newlines→<br> alternative; else pure text/plain — exactly the pre-branding behavior.
  const html = input.html
    ? (sig ? `${input.html}<br><br>${sig}` : input.html)
    : (sig ? `${textToHtml(input.body)}<br><br>${sig}` : null);

  // The body, as either a single text/plain part or a multipart/alternative (plain + html).
  const altBoundary = `alt_${randomUUID().replace(/-/g, "")}`;
  const bodyBlock = (): Buffer => {
    if (!html) {
      return Buffer.from(
        `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
        + `${b64wrap(Buffer.from(plain, "utf8"))}\r\n`, "utf8");
    }
    return Buffer.concat([
      Buffer.from(`Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`, "utf8"),
      Buffer.from(`--${altBoundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(Buffer.from(plain, "utf8"))}\r\n`, "utf8"),
      Buffer.from(`--${altBoundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(Buffer.from(html, "utf8"))}\r\n`, "utf8"),
      Buffer.from(`--${altBoundary}--\r\n`, "utf8"),
    ]);
  };

  if (!atts.length) {
    return b64url(Buffer.concat([Buffer.from(`${headers.join("\r\n")}\r\n`, "utf8"), bodyBlock()]));
  }

  // Attachments -> multipart/mixed wrapping the body block + each attachment.
  const mixBoundary = `friday_${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [
    Buffer.from(`${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${mixBoundary}"\r\n\r\n`, "utf8"),
    Buffer.from(`--${mixBoundary}\r\n`, "utf8"),
    bodyBlock(),
  ];
  for (const a of atts) {
    const name = a.filename.replace(/[\r\n"]/g, "");
    parts.push(Buffer.from(
      `--${mixBoundary}\r\nContent-Type: ${a.mime}; name="${name}"\r\n`
      + `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n`
      + `${b64wrap(a.content)}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${mixBoundary}--\r\n`, "utf8"));
  return b64url(Buffer.concat(parts));
}

export async function sendEmail(input: {
  to: string; subject: string; body: string; cc?: string; replyToThreadId?: string;
  inReplyTo?: string; references?: string; // RFC 2822 threading headers (thread in the recipient's mailbox)
  attachments?: EmailAttachment[];
  agent?: string; // stamp X-Agent — set for machine mail to the owner, never for client mail
  html?: string;  // optional pre-rendered text/html alternative (branded templated sends)
}, account: GoogleAccount = "owner"): Promise<{ ok: boolean; id?: string; threadId?: string; error?: string }> {
  const raw = await buildRaw(input, account);
  const r = await gfetch(`${BASE}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw, ...(input.replyToThreadId ? { threadId: input.replyToThreadId } : {}) }),
  }, account);
  if (!r.ok) return { ok: false, error: `gmail send ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  // threadId lets a caller find replies to THIS message later (the approval email loop lives on it).
  return { ok: true, id: j.id, threadId: j.threadId };
}

// The authenticated account's own address (Gmail sends "from" this).
export async function getProfile(account: GoogleAccount = "owner"): Promise<{ email?: string }> {
  try {
    const r = await gfetch(`${BASE}/profile`, {}, account);
    if (!r.ok) return {};
    const j = await r.json();
    return { email: j.emailAddress };
  } catch {
    return {};
  }
}

// Metadata of one inbound attachment part — bytes are NOT fetched here (see getAttachmentData; only
// the allowlisted subset is ever downloaded).
export interface InboundAttachment { filename: string; mimeType: string; sizeBytes: number; attachmentId: string }

// Full plain-text body + threading identifiers of a message (walks the MIME parts, base64url-decoded).
export async function getMessageBody(id: string, account: GoogleAccount = "owner"): Promise<{ subject: string; from: string; threadId: string; text: string; messageId: string; references: string; agent: string; internalDate: number; auto: boolean; attachments: InboundAttachment[]; authResults: string }> {
  const r = await gfetch(`${BASE}/messages/${id}?format=full`, {}, account);
  // internalDate: 0 on the error path is deliberate — it is older than any floor, so a failed fetch
  // can never be mistaken for a repliable message. Fails closed. See replyFloor.repliableAt().
  if (!r.ok) return { subject: "", from: "", threadId: "", text: "", messageId: "", references: "", agent: "", internalDate: 0, auto: false, attachments: [], authResults: "" };
  const j = await r.json();
  const h = (n: string) => (j.payload?.headers ?? []).find((x: { name: string }) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const decode = (data?: string) => data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
  let text = "";
  const attachments: InboundAttachment[] = [];
  const walk = (part: { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: unknown[] }) => {
    if (part.mimeType === "text/plain" && part.body?.data) text += decode(part.body.data);
    // A named part with an attachmentId is a real attachment (client screenshots/PDFs) — record the
    // metadata so emailAgent can capture the allowlisted ones. Never fetched here.
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType ?? "application/octet-stream", sizeBytes: part.body.size ?? 0, attachmentId: part.body.attachmentId });
    }
    if (part.parts) for (const p of part.parts) walk(p as typeof part);
  };
  if (j.payload) walk(j.payload);
  if (!text && j.payload?.body?.data) text = decode(j.payload.body.data);
  // X-Agent marks machine mail from a sibling agent (e.g. CLARA's owner notifications), which must
  // never be mistaken for client email — see isAgentMail() in emailAgent.ts.
  // internalDate is Gmail's authoritative receive instant (epoch ms, UTC) and arrives as a STRING.
  return {
    subject: h("Subject"), from: h("From"), threadId: j.threadId, text: text.slice(0, 8000),
    messageId: h("Message-ID"), references: h("References"), agent: h("X-Agent"), internalDate: Number(j.internalDate ?? 0),
    auto: isAutoGeneratedMail(h, h("From"), h("Subject")),
    attachments,
    // Gmail's own SPF/DKIM/DMARC verdict on this message — see dmarcExplicitFail() in
    // emailAgent.ts's phishing screen. A From header alone is just a string anybody can type.
    authResults: h("Authentication-Results"),
  };
}

// Download ONE attachment's bytes. Callers must allowlist mime/size BEFORE calling (see
// inboundAttachments.ts) — this fetches exactly what it is asked for and nothing else.
export async function getAttachmentData(messageId: string, attachmentId: string, account: GoogleAccount = "owner"): Promise<Buffer | null> {
  try {
    const r = await gfetch(`${BASE}/messages/${messageId}/attachments/${attachmentId}`, {}, account);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.data) return null;
    return Buffer.from(String(j.data).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
}

// Create a DRAFT reply (never auto-sends). Needs gmail.modify scope. Supports Cc + threading headers.
// Uses the same builder as sendEmail, so a drafted commitment reply carries the account's signature
// and sends byte-identical once the owner approves it (drafts/send).
export async function createDraft(input: { to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyTo?: string; references?: string; html?: string }, account: GoogleAccount = "owner"): Promise<{ ok: boolean; id?: string; error?: string }> {
  const raw = await buildRaw(input, account);
  const r = await gfetch(`${BASE}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } }) }, account);
  if (!r.ok) return { ok: false, error: `gmail draft ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  return { ok: true, id: j.id };
}

// Send an existing draft (used when the owner approves a commitment reply). Sends from `account`.
export async function sendDraft(draftId: string, account: GoogleAccount = "owner"): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await gfetch(`${BASE}/drafts/send`, { method: "POST", body: JSON.stringify({ id: draftId }) }, account);
  if (!r.ok) return { ok: false, error: `gmail draft send ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` };
  const j = await r.json();
  return { ok: true, id: j.id };
}

// Discard a draft (used when the owner rejects a commitment reply).
export async function deleteDraft(draftId: string, account: GoogleAccount = "owner"): Promise<boolean> {
  const r = await gfetch(`${BASE}/drafts/${draftId}`, { method: "DELETE" }, account);
  return r.ok;
}

// One earlier message in a thread, for context only — never a thing FRIDAY acts on.
export interface ThreadMessage { from: string; at: string; text: string }

// A thread message with everything the approval-reply poller needs. Distinct from getThread():
// that one collapses whitespace (fine for prompt context, fatal for quote-stripping — the
// "^>" and "On … wrote:" markers only exist on their own LINES) and returns no headers.
export interface ThreadMessageDetail {
  id: string;
  from: string;
  internalDate: number; // epoch ms, Gmail-authoritative
  text: string;         // raw text/plain, NEWLINES PRESERVED
  agent: string;        // X-Agent header — "" for human mail, set on every FRIDAY-sent message
  messageId: string;    // RFC 2822 Message-ID (for In-Reply-To when answering)
  references: string;   // RFC 2822 References chain
  auto: boolean;        // auto-generated (out-of-office / list / bounce) — never reply, or threads loop
}

// Shared auto-generated-mail test (RFC 3834 + de-facto headers + sender/subject shape). Used by both
// the inbound handler and the client-review poller so neither ever replies into an infinite loop.
export function isAutoGeneratedMail(h: (name: string) => string, from: string, subject: string): boolean {
  const autoSub = h("Auto-Submitted").trim().toLowerCase();
  if (autoSub && autoSub !== "no") return true;
  if (h("X-Auto-Response-Suppress").trim()) return true;
  const prec = h("Precedence").trim().toLowerCase();
  if (prec === "bulk" || prec === "junk" || prec === "auto_reply" || prec === "list") return true;
  if (h("X-Autoreply").trim() || h("X-Autorespond").trim()) return true;
  if (h("List-Id").trim()) return true;
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  if (/(^|[._+-])(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce)/i.test(addr)) return true;
  const subj = subject.trim();
  return /^(automatic reply:|auto(reply)?:)/i.test(subj) || /out of office/i.test(subj);
}

// Full-fidelity thread read for reply processing. Oldest-first. Fails soft to [] — the caller
// treats a failed fetch as "nothing new" and retries next cycle.
export async function getThreadDetail(threadId: string, account: GoogleAccount = "owner"): Promise<ThreadMessageDetail[]> {
  const r = await gfetch(`${BASE}/threads/${threadId}?format=full`, {}, account);
  if (!r.ok) return [];
  const j = await r.json();
  const out: ThreadMessageDetail[] = [];
  for (const m of (j.messages ?? []) as { id: string; internalDate?: string; snippet?: string; payload?: unknown }[]) {
    const h = (n: string) => ((m.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers ?? [])
      .find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    let text = "";
    const walk = (part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) => {
      if (part.mimeType === "text/plain" && part.body?.data) text += Buffer.from(part.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      else if (part.parts) for (const p of part.parts) walk(p as typeof part);
    };
    if (m.payload) walk(m.payload as Parameters<typeof walk>[0]);
    out.push({
      id: m.id,
      from: h("From"),
      internalDate: Number(m.internalDate ?? 0),
      text: (text || m.snippet || "").trim(),
      agent: h("X-Agent"),
      messageId: h("Message-ID") || h("Message-Id"),
      references: h("References"),
      auto: isAutoGeneratedMail(h, h("From"), h("Subject")),
    });
  }
  return out;
}

// Earlier messages in a thread, oldest-first, so a reply can be aware of the conversation so far
// rather than answering each mail as if it arrived out of nowhere.
//
// Reading is not replying: this deliberately reaches further back than the reply floor allows her to
// answer. The floor gates who gets a response; this only informs what that response knows.
//
// Everything returned is UNTRUSTED — it is whatever a client (or anyone who can mail them) typed.
// Callers must quote it into prompts as reference material, never as instruction.
export async function getThread(
  threadId: string,
  account: GoogleAccount = "owner",
  opts: { sinceMs?: number; max?: number; excludeId?: string } = {},
): Promise<ThreadMessage[]> {
  const max = opts.max ?? 8;
  const r = await gfetch(`${BASE}/threads/${threadId}?format=full`, {}, account);
  if (!r.ok) return []; // context is a nice-to-have; never fail a reply over it
  const j = await r.json();
  const out: ThreadMessage[] = [];
  for (const m of (j.messages ?? []) as { id: string; internalDate?: string; payload?: unknown; snippet?: string }[]) {
    if (opts.excludeId && m.id === opts.excludeId) continue; // the message we're replying to
    const at = Number(m.internalDate ?? 0);
    if (opts.sinceMs != null && !(at >= opts.sinceMs)) continue; // affirmative — NaN/0 drop out
    const h = (n: string) => ((m.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers ?? [])
      .find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    let text = "";
    const walk = (part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) => {
      if (part.mimeType === "text/plain" && part.body?.data) text += Buffer.from(part.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      else if (part.parts) for (const p of part.parts) walk(p as typeof part);
    };
    if (m.payload) walk(m.payload as Parameters<typeof walk>[0]);
    text = (text || m.snippet || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ from: h("From"), at: at ? new Date(at).toISOString() : "", text: text.slice(0, 600) });
  }
  // Keep the most RECENT `max` (the tail), then restore oldest-first — recent turns carry the thread.
  return out.slice(-max);
}

// internalDate: Gmail's authoritative receive instant (epoch ms, UTC). `date` is the Date HEADER,
// which is sender-supplied and therefore forgeable/skewed — never gate on it. See replyFloor.ts.
export interface MailSummary { id: string; threadId: string; from: string; subject: string; snippet: string; date: string; internalDate: number; }

export async function searchMessages(query: string, max = 10, account: GoogleAccount = "owner"): Promise<MailSummary[]> {
  const list = await gfetch(`${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`, {}, account);
  if (!list.ok) return [];
  const ids = (await list.json()).messages ?? [];
  const out: MailSummary[] = [];
  for (const m of ids.slice(0, max)) {
    const r = await gfetch(`${BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {}, account);
    if (!r.ok) continue;
    const j = await r.json();
    const h = (n: string) => (j.payload?.headers ?? []).find((x: { name: string }) => x.name === n)?.value ?? "";
    // internalDate is a top-level Message field, so format=metadata already returns it — no extra
    // metadataHeaders needed. Having it here lets the floor filter BEFORE any body fetch or LLM call.
    out.push({ id: j.id, threadId: j.threadId, from: h("From"), subject: h("Subject"), snippet: j.snippet ?? "", date: h("Date"), internalDate: Number(j.internalDate ?? 0) });
  }
  return out;
}
