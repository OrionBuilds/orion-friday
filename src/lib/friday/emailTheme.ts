// FRIDAY — client email presentation (owner ask 2026-07-19: client-experience polish).
//
// The light agency wrapper for TEMPLATED client sends ONLY (weekly update, review-ready, welcome).
// Conversational replies stay personal plain text by design — a styled shell around a two-line answer
// reads as a newsletter, not a colleague. DETERMINISTIC: no LLM near rendering; text is escaped
// before any markup is applied, so nothing in a task title can inject HTML.
//
// Email-client constraints: table layout, inline styles, no remote images (text wordmark, not a
// logo), neutral colors that survive dark mode. The plain-text part always carries the full content —
// worst rendering outcome is exactly today's email. Independent of any sibling agent's emailTheme (hard
// rule: the apps share nothing).
//
// Kill switch: FRIDAY_EMAIL_BRANDING=off → callers skip the wrapper (plain path, byte-identical to today).

import { AGENCY } from "@/lib/friday/persona";

export function brandingEnabled(): boolean {
  return (process.env.FRIDAY_EMAIL_BRANDING ?? "on").trim().toLowerCase() !== "off";
}

function agencyName(): string {
  return process.env.FRIDAY_AGENCY_NAME?.trim() || AGENCY;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const P_STYLE = 'style="margin:0 0 12px;line-height:1.55;color:#24222b;font-size:15px;"';

/** Plain prose → escaped `<p>` blocks (one per blank-line-separated paragraph), no shell. */
export function textParagraphs(text: string): string {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p ${P_STYLE}>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** The branded shell: text wordmark header, content card, "just reply" footer. */
export function renderBranded(input: { bodyHtml: string }): string {
  const name = escapeHtml(agencyName());
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5fb;padding:18px 0;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:94%;background:#ffffff;border:1px solid #e7e4f2;border-top:3px solid #5C27FE;border-radius:8px;">',
    `<tr><td style="padding:18px 28px 4px;"><span style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#5C27FE;font-weight:bold;">${name}</span></td></tr>`,
    `<tr><td style="padding:10px 28px 6px;font-family:Arial,Helvetica,sans-serif;">${input.bodyHtml}</td></tr>`,
    `<tr><td style="padding:12px 28px 20px;border-top:1px solid #efedf7;font-size:12px;color:#8b87a0;font-family:Arial,Helvetica,sans-serif;">Questions? Just reply to this email.</td></tr>`,
    "</table>",
    "</td></tr></table>",
  ].join("");
}

/** Branded shell for a plain-prose body — the common case for FRIDAY's templated sends. */
export function renderBrandedText(bodyText: string): string {
  return renderBranded({ bodyHtml: textParagraphs(bodyText) });
}

/** The html argument for a templated send: branded when enabled, undefined (plain path) when not. */
export function brandedHtmlFor(bodyText: string): string | undefined {
  return brandingEnabled() ? renderBrandedText(bodyText) : undefined;
}
