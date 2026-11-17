// Client-facing brand strings (audit 2026-10-28, public-template rule): the sign-off and author name on
// everything FRIDAY says to a client used to be a hardcoded company name. Each deployment's FRIDAY must sign
// as that deployment's business, so the company name now comes from config:
//   1. FRIDAY_CLIENT_SIGNOFF (env) — explicit, wins;
//   2. the OS organization's name (org_settings_get, cached by clientComms.ts — no extra call);
//   3. the owner profile's business.name (agent-core getOwnerProfile — a local file read, cheap),
//      ignored when it is still the fake placeholder profile;
//   4. nothing — copy then signs as plain "FRIDAY" with no company suffix.

import { getOwnerProfile, DEFAULT_OWNER_PROFILE } from "@autom8ionlab/agent-core";
import { osOrgName } from "@/lib/friday/clientComms";

/** The business name client copy is signed with, or null when none is configured. */
export function clientCompanyName(env: Record<string, string | undefined> = process.env, orgName: string | null = osOrgName()): string | null {
  const explicit = (env.FRIDAY_CLIENT_SIGNOFF ?? "").trim();
  if (explicit) return explicit;
  if (orgName) return orgName;
  try {
    const name = getOwnerProfile().business?.name?.trim();
    if (name && name !== DEFAULT_OWNER_PROFILE.business?.name) return name;
  } catch { /* malformed profile — fall through to no suffix */ }
  return null;
}

/** "— <Company>" (or "— FRIDAY, <Company>" when `who` is given); "— FRIDAY" when no company is configured. */
export function clientSignoff(who?: string, env: Record<string, string | undefined> = process.env): string {
  const co = clientCompanyName(env);
  if (!co) return `— ${who ?? "FRIDAY"}`;
  return who ? `— ${who}, ${co}` : `— ${co}`;
}

/** Portal comment author: "FRIDAY (<Company>)" or plain "FRIDAY". */
export function agentAuthorName(env: Record<string, string | undefined> = process.env): string {
  const co = clientCompanyName(env);
  return co ? `FRIDAY (${co})` : "FRIDAY";
}

/** "at <Company>" phrase for LLM persona prompts ("" when unconfigured). */
export function atCompany(env: Record<string, string | undefined> = process.env): string {
  const co = clientCompanyName(env);
  return co ? ` at ${co}` : "";
}
