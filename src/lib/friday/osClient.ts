// FRIDAY ↔ Orion MCP wiring.
//
// FRIDAY connects to the OS MCP server (localhost:3100/mcp, 470 CRM tools) as its OWN OS user —
// a Google-Workspace account (friday@…) whose OS role is scoped to Engineering-department modules.
// CORRECTION (verified live, 2026-07-27): RLS does NOT enforce that scope on most tables — only
// payments/invoices/forms/reviews/workflows check a real permission; projects, contacts,
// opportunities, and most everything else only check org membership. FRIDAY_OS_TOOLS (see
// agent-core/src/osmcp/allowlists.ts for the full audit) is the PRIMARY department boundary for
// reads, not defense-in-depth. Treat it accordingly — it's the real thing, not a backstop.
//
//   osAuth   — mints/refreshes FRIDAY's Supabase user JWT from the vault (~/.agentic-os/friday).
//   osClient — native MCP client for deterministic backend calls, with a dept allow-list predicate.
//   OS_CLI_* — the flags engines.ts adds when it lets a dispatched `claude -p` reach the OS MCP.
//
// The one-time interactive sign-in that populates the vault is done via /api/os/auth (see
// src/app/api/os/auth/*). Until then, osAuth.osConfigured() is false and OS access is inert.

import path from "node:path";
import os from "node:os";
import { OsAuth, OsMcpClient, allowExact, FRIDAY_OS_TOOLS, toCliAllowedTools } from "@autom8ionlab/agent-core";
import { noteOsCallOutcome } from "@/lib/friday/osAuthLedger";
import { cachedAgentSettings, settingsFor, filterTools } from "@/lib/friday/agentSettings";

const REDIRECT_URI =
  process.env.ORION_REDIRECT_URI ?? "http://127.0.0.1:3737/os/auth/capture";

export const osAuth = new OsAuth({
  // Same dir as the store (AGENTIC_OS_FRIDAY_DATA overrides) so a test process with a temp data dir
  // never opens — or chmods — the live vault.
  agentDir: process.env.AGENTIC_OS_FRIDAY_DATA ?? path.join(os.homedir(), ".agentic-os", "friday"),
  // No built-in project (agent-core 2026-10-28): unset ⇒ OS access is off with a clear error.
  supabaseUrl: process.env.ORION_SUPABASE_URL,
  supabaseAnonKey: process.env.ORION_SUPABASE_ANON_KEY,
  redirectUri: REDIRECT_URI,
  // The callback route is unauthenticated by design (the capture page POSTs to it), so this
  // pin is what stops an arbitrary valid OS session from rebinding FRIDAY's vault to a
  // different user — captureSession rejects any verified email that isn't FRIDAY's own.
  // REQUIRED config (no hardcoded identity — public-template rule, 2026-10-28 audit). Unset fails
  // CLOSED: the sentinel matches no real address, so a re-auth is refused with a message naming it
  // until ORION_EXPECTED_EMAIL is set. An existing stored session keeps working either way.
  expectedEmail: process.env.ORION_EXPECTED_EMAIL?.trim() || "Orion-expected-email-not-configured@invalid",
});

// FRIDAY = Engineering. FRIDAY_OS_TOOLS is agent-core's shared, exact-tool-name allowlist verified
// against the real mcp-server registrations AND the real RLS policies (most tables don't scope by
// role — this list is the actual boundary) — single source of truth for both this predicate and the
// CLI's --allowedTools below, so the two enforcement points can't drift apart.
class LedgeredOsMcpClient extends OsMcpClient {
  // Every native OS call feeds the auth-failure ledger, so the liveness alarm sees a broken session
  // (refresh_token_already_used & co.) from ANY path — projects/contacts sync, bridges, pollers —
  // not only from the paths that remembered to report it (audit gap 8: 2.5 days went unnoticed).
  override async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const out = await super.callTool(name, args);
      noteOsCallOutcome(null);
      return out;
    } catch (e) {
      noteOsCallOutcome(e);
      throw e;
    }
  }
}

export const osClient = new LedgeredOsMcpClient({
  auth: osAuth,
  url: process.env.ORION_MCP_URL,                     // undefined → default localhost:3100/mcp
  allow: allowExact(FRIDAY_OS_TOOLS),
  clientName: "friday-osmcp",
});

/** True once FRIDAY has completed the one-time OS sign-in (vault has a refresh token). */
export function osEnabled(): boolean {
  return osAuth.osConfigured();
}

// ── CLI wiring (engines.ts) ────────────────────────────────────────────────
// When a dispatched `claude -p` is allowed to touch the OS, engines.ts loads FRIDAY's .mcp.json
// (which registers the Orion HTTP server) and allow-lists exact `mcp__orion__<tool>` names —
// prefix wildcards are unreliable in --allowedTools, so we enumerate FRIDAY_OS_TOOLS exactly
// (same list the native client's allow predicate above uses, and the same real boundary — see
// the correction at the top of this file about RLS not covering most tables).
export const OS_MCP_CONFIG_PATH = path.join(process.cwd(), ".mcp.json");
export const OS_CLI_MCP_ALLOW = toCliAllowedTools(FRIDAY_OS_TOOLS);
export const OS_CLI_LOCAL_READ = ["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite"];
export const OS_CLI_LOCAL_WRITE = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task"];

/**
 * FRIDAY_OS_TOOLS narrowed by the OS agent settings (allowed/denied for `friday` or `friday.<role>`),
 * as exact CLI names. Never widens; no settings → the full compiled list, exactly as before. The
 * native osClient above is NOT filtered: it carries FRIDAY's own backend syncs, not agent work.
 */
export function osCliMcpAllow(agentId?: string): string[] {
  const entry = settingsFor(cachedAgentSettings(), agentId);
  if (!entry) return OS_CLI_MCP_ALLOW;
  return toCliAllowedTools(filterTools(FRIDAY_OS_TOOLS, (t) => t, entry));
}

/** The `--allowedTools` value for an OS-enabled run. Includes local write tools only when `write`. */
export function osCliAllowedTools(write: boolean, agentId?: string): string {
  return [...OS_CLI_LOCAL_READ, ...(write ? OS_CLI_LOCAL_WRITE : []), ...osCliMcpAllow(agentId)].join(",");
}
