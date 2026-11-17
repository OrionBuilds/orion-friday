// FRIDAY — core domain types for the Agentic OS.
// These are the entities FRIDAY orchestrates client delivery around. The persistence
// layer (lib/persistence) is generic over these; the same shapes map 1:1 to Supabase
// tables when that backend is added later.

import { normalizeGithubUrl } from "./githubOwner";

export type ISO = string; // ISO-8601 timestamp

export type ProjectStatus = "active" | "paused" | "done" | "archived";
// Project pipeline stages — see lib/friday/stages.ts for order, labels, and transitions.
export type TaskStatus =
  | "planning"
  | "on_hold"
  | "blocked"
  | "in_progress"
  | "waiting_on_client"
  | "internal_review"
  | "qa_testing"
  | "client_review"
  | "revisions"
  | "bug_fixes"
  | "maintenance"
  | "supporting"
  | "completed"
  | "delivered";
export type Risk = "low" | "medium" | "high" | "critical";
export type AgentRole =
  | "orchestrator"
  | "architect"
  | "dev"
  | "devops"
  | "qa"
  | "review"
  | "debug"
  | "automation"
  | "pm"
  | "support"
  | "research-qa"
  | "seo"
  | "marketing"
  | "sales"
  | "designer"
  | "custom";
export type Engine = "claude" | "lmstudio" | "hermes" | "codex" | "antigravity";
export type AgentSource = "builtin" | "claude" | "multica" | "import";
// "os_ticket" = a client-portal support ticket / change request pulled from the OS.
// Deliberately NOT in the bypass-eligible set (bypassEligible admits only
// email/sms/voice), so portal-originated work can never auto-ship code.
export type Channel = "web" | "sms" | "voice" | "email" | "os_ticket";
// Who ASKED for a piece of work, independent of the channel it arrived on (2026-09 origin-aware
// autonomy). owner = the owner (UI/SMS/voice/board); clara = CLARA's delegation bridge (owner-sanctioned by
// construction — she only relays their asks); scheduler = FRIDAY's own timed jobs / OS-scheduled runs
// (owner-sanctioned standing work); client = a client, over any channel. authority.decideAutonomy
// keys on this: everything non-client is auto unless it costs money or trips a hard floor.
export type RequestOrigin = "owner" | "clara" | "client" | "scheduler";

export interface Client {
  id: string;
  /** OS contact UUID backing this row since M1 (clients live in OS contacts; this local
   *  record is a synced mirror — see lib/friday/contactsBridge.ts). Absent only on rows
   *  created while the OS was unreachable, until the next sync reconciles them. */
  osContactId?: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  timezone?: string;      // IANA tz (e.g. "America/New_York") for quiet-hours; derived from state if unset
  // Delegated Authority (Wave-1 #2): how much FRIDAY may do for this client without an approval click.
  // Absent ⇒ "conservative" (everything Tier 3, today's behavior). See lib/friday/authority.ts.
  authorityProfile?: "conservative" | "standard" | "aggressive";
  // Owner-granted, single-client autonomy carve-out (2026-07-27): full auto-execute + auto-merge +
  // auto-deploy, no approval, gated additionally by FRIDAY_CLIENT_BYPASS (default off) and a hard
  // deletion/money/transfer content filter — see taskIntake.bypassEligible(). Absent/false ⇒ today's
  // behavior, unchanged. Deliberately separate from authorityProfile/POLICY (authority.ts), which
  // hard-floors deploy/email_reply at Tier 3 for every profile — this must never loosen that for
  // anyone else.
  bypassPolicy?: { enabled: boolean; grantedAt: ISO; reason?: string };
  status: "prospect" | "active" | "paused" | "past";
  notes?: string;
  tags?: string[];
  // Client-experience stamps (2026-07-19, all optional/additive):
  welcomeQueuedAt?: ISO;      // welcome email parked in approve-to-send — at most once per client, ever
  lastFeedbackAskAt?: ISO;    // cadence guard: max one "how'd we do?" per FRIDAY_FEEDBACK_MIN_DAYS
  lastFeedbackScore?: number; // most recent 1-5 rating the client gave
  lastFeedbackNote?: string;  // their words alongside the score (short excerpt)
  driveFolderId?: string; // Google Shared-Drive folder id for this client's doc library — resolved once, cached
  // Clarify-loop bound (2026-09-17, Taylor incident): consecutive "clarify" turns on the current
  // back-and-forth. Resets to 0 the moment any non-clarify intent fires. See clientChannel.ts —
  // a second consecutive clarify forces resolution into a real request instead of asking again.
  clarifyStreak?: number;
  clarifyStreakAt?: ISO; // last time the streak changed — stale streaks (>2h) don't carry into a new conversation
  createdAt: ISO;
  updatedAt: ISO;
}

// ── Client documents (owner-uploaded context: proposals, plans, strategy docs) ──────────────
// Uploaded on the client card (any status — past clients included) so FRIDAY's agents have the
// client's real context. Raw file lives path-jailed under FRIDAY_DATA_DIR/docs/<clientId>/;
// extracted text is chunked into institutional memory (kind "doc") and distilled into a brief.
export type DocCategory = "proposal" | "plan" | "strategy" | "brief" | "contract" | "other";
export type DocKind = "pdf" | "docx" | "txt" | "md" | "csv";
export type DocStatus = "processing" | "ready" | "failed";
export interface ClientDoc {
  id: string;
  clientId: string;
  filename: string;      // original upload name (sanitized)
  kind: DocKind;
  mime: string;
  sizeBytes: number;
  path: string;          // absolute, jailed under DOCS_ROOT (docs/storage.ts)
  category: DocCategory; // purpose tag — drives the brief lens + UI badges
  extractedText: string; // plain text, capped at EXTRACT_CAP (60k)
  extractedChars: number; // full pre-cap length
  brief?: string;        // LLM-distilled markdown summary (category-aware lens)
  driveFileId?: string;  // mirrored raw file in the client's Drive "Documents" folder
  driveUrl?: string;
  driveBriefFileId?: string; // mirrored "<name> — brief.md" sidecar
  driveModifiedTime?: string; // Drive-side modifiedTime at pull (drive_pull rows; re-pull on change)
  source: "upload" | "drive_pull";
  status: DocStatus;
  error?: string;
  uploadedAt: ISO;
  updatedAt: ISO;
}

export interface Project {
  id: string;
  clientId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  startDate?: string;      // YYYY-MM-DD
  targetEndDate?: string;  // YYYY-MM-DD
  budget?: number;         // USD
  stack?: string;
  repoUrl?: string;      // GitHub — DEPRECATED single value; kept synced to repoUrls[0] for back-compat
  repoUrls?: string[];   // GitHub — canonical list of every repo attached to this project
  deployUrl?: string;    // Netlify — production URL
  stagingUrl?: string;   // Netlify — latest branch/deploy-preview URL, so client review-by-link works
  netlifySiteId?: string; // Netlify site id — resolved once, cached for in-process deploys/cache-purges
  supabaseRef?: string;  // Supabase project ref
  driveFolderId?: string; // Google Shared-Drive folder id for this project's deliverable library — cached
  // The project's files folder as set in the OS (projects.files_*). "microsoft" = SharePoint/OneDrive:
  // FRIDAY then leaves driveFolderId unset and does not create a Google library for the project.
  filesProvider?: "google" | "microsoft";
  filesDriveId?: string;
  filesFolderId?: string;
  filesFolderName?: string;
  filesFolderUrl?: string;
  // Last change to repos / deployUrl / supabaseRef / files. The OS is the source of truth; on sync the
  // newer of this and the OS's connections_updated_at wins (connectionsSync.ts).
  connectionsUpdatedAt?: ISO;
  workspaceDir?: string; // FRIDAY scratch/workspace for this project
  portalUpdates?: boolean; // false ⇒ never post to the client portal feed (internal repos, e.g. FRIDAY itself). Absent = on.
  // Task-branch namespace. "friday-work" for repos that already have a branch named `friday` (git
  // can't hold both `friday` and `friday/<x>`; caseyclient1/retirement-income-dashboard, 2026-09-29).
  branchPrefix?: "friday" | "friday-work";
  clientSignoff?: boolean; // true ⇒ FRIDAY files a portal "Ready for your review" card for feature PRs and waits for the client before merging. Default off. The owner is never in the loop either way.
  closedAt?: ISO;        // when the project was offboarded (status → archived)
  warrantyUntil?: ISO;   // free-bugfix window after close (default close + 30d); feature asks route to sales
  createdAt: ISO;
  updatedAt: ISO;
}

// Canonical read for a project's repos: the local multi-repo list, falling back to the legacy single
// repoUrl. The OS (projects.repo_urls) is the source of truth, and connectionsSync.ts keeps this local
// list in step with it both ways — so there is NO separate OS lookup here (2026-10-28 audit gap 5,
// reworked onto the upstream connections sync). Every URL is normalised from a legacy GitHub owner
// (example-org) to GITHUB_OWNER in memory and deduped; the stored value is left alone.
/** The locally stored repo list only (no normalisation) — for edits of the local store. */
export function localProjectRepos(p: Pick<Project, "repoUrl" | "repoUrls">): string[] {
  return p.repoUrls && p.repoUrls.length ? p.repoUrls : p.repoUrl ? [p.repoUrl] : [];
}

export function projectRepos(p: Pick<Project, "repoUrl" | "repoUrls">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of localProjectRepos(p)) {
    const n = normalizeGithubUrl(u);
    const k = n.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}

// Project fields that are "connections" (synced with the OS projects row, connectionsSync.ts).
// repo.updateProject stamps connectionsUpdatedAt on any patch that changes one of them.
export const CONNECTION_KEYS = [
  "repoUrl", "repoUrls", "supabaseRef", "deployUrl", "driveFolderId",
  "filesProvider", "filesDriveId", "filesFolderId", "filesFolderName", "filesFolderUrl",
] as const satisfies readonly (keyof Project)[];

export interface Task {
  id: string;
  projectId: string;
  title: string;         // imperative work statement ("Update order confirmation email") — never an email subject
  description?: string;  // legacy prose blob — composed FROM the structured fields below for new tasks,
                         // so run prompts / approval detail / Obsidian keep working unchanged
  status: TaskStatus;
  assignee: string;      // agent id, or "human"
  risk: Risk;
  order: number;         // position within its status column
  runId?: string;        // last/active agent run
  sourceRunId?: string;  // the run whose findings spawned this task (e.g. a [Fix] task ← its QA run)
  origin?: Channel;      // how the task was created — "web" (board/UI) | "sms" | "voice" | "email"
  requestOrigin?: RequestOrigin; // WHO asked (owner/clara/scheduler/client) — drives decideAutonomy; absent ⇒ inferOrigin()
  originContact?: string; // for sms/voice: the phone number that created it (notify-back target)
  // ── Request provenance (all optional — rows written before these existed deserialise fine) ──
  requestedBy?: string;        // display name of who asked: the client, or the owner
  requesterClientId?: string;  // set when a CLIENT asked (deliberately not `clientId` — a task's
                               // project already has one, and the two need not agree forever)
  requestKind?: "bug" | "feature" | "change" | "other"; // drives assignee/status/risk + bug closed-loop
  requestId?: string;          // the Request (client-ask lifecycle) this task belongs to, if any
  details?: string;            // what was asked, in clean prose — no quoted reply-chains
  executionPlan?: string;      // what needs to happen, naming the agent role ("The Developer updates…")
  // Stamped true at creation when taskIntake.bypassEligible() granted this task the owner-approved
  // single-client autonomy carve-out — see Client.bypassPolicy. Lets downstream steps (auto-merge,
  // auto-deploy in orchestrator.maybeAutoQA) act without re-deriving eligibility from the client record.
  bypassAuthority?: boolean;
  // ── Lineage (PR shepherd, 2026-09-24) ──
  sourceTaskId?: string; // the task an auto-round ([QA]/[Fix]/[Review]/[Rebase]) serves — the root of its chain
  prUrl?: string;
  prHeadRef?: string;          // head branch of that PR — a shepherd round runs in a worktree on it, never the owner's checkout        // the pull request this task's work lives on (set when a run produces a verified PR)
  qaPassedAt?: ISO;      // the [QA] round for this task's latest run returned VERDICT: PASS
  createdAt: ISO;
  updatedAt: ISO;
}

// ── Client request lifecycle ────────────────────────────────────────────────
// A single actionable ask extracted from a client (Section-5 extraction unit) — promoted to a
// first-class entity that OWNS its task(s) and moves through review. One Request per distinct ask.
// The state machine (see clientReview.ts) is what lets FRIDAY close deliverables without the owner:
//   logged → clarified → approved → in_progress → qa_passed → client_review → client_accepted → closed
// with a `changes_requested` revision loop and a `cancelled` exit. A false auto-close is impossible by
// construction — see classifyClientReview (the accept path is the conservative one).
export type RequestState =
  | "logged"            // created; task exists, gate decided per tier
  | "clarified"         // (reserved) client answered a clarifying question
  | "approved"          // Tier-2 auto-approved, or owner approved a Tier-3 — task dispatched
  | "in_progress"       // a task run has started
  | "qa_passed"         // every deliverable task passed QA — ready to show the client
  | "client_review"     // review email sent; awaiting the client's reply
  | "changes_requested" // client asked for changes — a revision task is running (loops to in_progress)
  | "client_accepted"   // client signed off
  | "closed"            // wrapped (accepted, or auto-closed after silence)
  | "cancelled";        // abandoned/withdrawn

export interface Request {
  id: string;
  projectId: string;
  clientId: string;
  contactId?: string;          // (Phase 2) which POC asked — falls back to the client's primary contact
  title: string;               // the imperative ask, mirrors the owning task's title
  summary?: string;            // client-safe one-liner of what was delivered (filled at review time)
  state: RequestState;
  scope: "in_scope" | "new";   // the authority tier this was routed under (fail-closed "new")
  // 2026-09 origin-aware autonomy: the GROUNDED verdict (OS contract-scope index when the project is
  // mapped, else the LLM's own `scope`), including "unknown" when it could not be determined. What
  // decideAutonomy actually keyed on; `scope` above stays the fail-closed two-state routing record.
  scopeVerdict?: "in_scope" | "new" | "unknown";
  revisionRound: number;       // 0 initially; ++ each changes_requested loop (escalates at 3)
  taskIds: string[];           // the task(s) this request owns (revisions append here)
  // ── Client review in the OS project portal (see clientReview.ts; 2026-10-28) ──
  reviewOsId?: string;         // OS client_reviews row for the CURRENT round (drives the state machine)
  reviewPortalUrl?: string;    // the client's portal link for that review
  // Legacy Gmail-era review thread fields (read-only now; kept so old rows still parse).
  reviewThreadId?: string;
  reviewAccount?: "owner" | "friday";
  reviewSubject?: string;
  reviewSentAt?: ISO;          // when the current review round was filed
  reviewSeenMs?: number;       // newest client comment (ms) already processed
  reviewAttempts?: number;     // submit-retry counter (capped)
  reviewNudgedAt?: ISO;        // day-3 nudge sent once (idempotency)
  acceptedAt?: ISO;
  closedReason?: "accepted" | "silence" | "cancelled";
  origin?: Channel;            // how the ask arrived
  originContact?: string;      // sms/voice number, if that's how it came in
  createdAt: ISO;
  updatedAt: ISO;
}

// One outstanding (or historical) clarify round on a portal ticket/change request (2026-09-18 — the
// "respond inside the projects module" feature). Structural sibling of Request's review-thread
// fields above — same idea, applied to a portal item instead of a Request, because a ticket/CR
// being clarified deliberately has no local Task/Request yet: routing is held until the ambiguity
// is resolved. Tracks both reply channels (portal comment + the mirrored clarify email) so either
// one can answer the question.
export type ClarifyItemKind = "ticket" | "cr";

// resolve/force_resolve don't carry the effective description — it's reconstructed at apply-time
// from the record's own `description` + `qa` (never duplicated, so it can't drift).
export type ClarifyPendingAction =
  | { type: "ask_again"; question: string }
  | { type: "resolve" }
  | { type: "force_resolve" };

export interface TicketClarify {
  id: string;
  kind: ClarifyItemKind;
  osId: string;                 // ticket_id or change_request_id
  osProjectId: string;
  localProjectId?: string;      // FRIDAY project id, when the OS project is mapped
  subject: string;
  description: string;          // original ticket/CR description/details — never mutated
  requestType?: string;         // ticket's request_type (kind classification input); unused for CRs
  clientEmail?: string;
  clientName?: string;
  qa: Array<{ question: string; answer: string }>; // every round's question + the client's answer, in order
  round: 1 | 2;
  question: string;             // the clarifying question currently outstanding (round `round`)
  // "ask_queued": the ambiguity was detected and an approval to ask was parked, but the question
  // has NOT been posted to the client yet (2026-09-18 code-review fix — a record used to only get
  // created once an "ask" approval was granted, so nothing stopped ticketTriage's next sweep from
  // re-classifying the same still-unposted item and parking a SECOND duplicate ask every run).
  // Creating the record at park-time, in this state, lets the main loop skip re-classifying any
  // ticket/CR that already has one. It transitions to "awaiting_reply" only once the question is
  // actually posted (direct, or via deliverTicketClarify/deliverCrClarify after approval) — the
  // silence clock (askedAt) must start there, not at park-time, or a slow approval would make the
  // very first silence-sweep after posting immediately look overdue.
  status: "ask_queued" | "awaiting_reply" | "resolved" | "forced" | "cancelled";
  // Scope-gate config the CR was queued under (CRs only) — read back at resolve/reject time instead
  // of a hardcoded default, so a schedule that customized scope_check/strict_scope away from the
  // default keeps that behavior across a clarify round (2026-09-18 code-review fix).
  scopeCheck?: boolean;
  strictScope?: boolean;
  // ── Email side (mirrors Request.reviewThreadId et al.) ──
  emailThreadId?: string;
  emailAccount?: "owner" | "friday";
  emailSubject?: string;
  emailSeenMs?: number;         // newest client-reply internalDate already processed (either round)
  // ── Portal side ──
  askedAt: ISO;                 // when THIS round's question was posted — silence-timer origin;
                                 // "" while status is "ask_queued" (not posted yet)
  // ── Deferred-approval fallback: pollClarifyReplies (a bare scheduler job) can't create an OS
  // approval itself (only a DueRun handler can) — when the direct-post gate is closed, the fully
  // -computed outcome is stashed here for the next ticketTriage/changeRequestTriage sweep to turn
  // into a normal approval. Never re-decided once stashed. ──
  needsApprovalFallback?: boolean;
  pendingAction?: ClarifyPendingAction;
  // Set when a fallback "apply" action is queued for approval; cleared once applied. Stops the
  // fallback-consumption pass from re-queuing a duplicate approval every sweep while the first one
  // is still pending (2026-09-18 code-review fix) — same staleness window as MARKER_MAX_AGE_MS, so
  // a genuinely lost approval still self-heals.
  fallbackQueuedAt?: ISO;
  // ── Silence handling ──
  nudgedAt?: ISO;                // 24h SMS nudge sent once per round
  escalatedAt?: ISO;             // owner page sent once per round
  createdAt: ISO;
  updatedAt: ISO;
}

// One model/engine call, recorded for the spend ledger + breaker (2.2). Tokens/cost are best-effort:
// present when the engine reports them (LM Studio usage, Codex trailer, Claude stream result), else
// undefined. costUsd prefers an engine-reported figure, else is derived from tokens + a price table.
export interface ModelCall {
  id: string;
  ts: ISO;
  engine: string;
  model?: string;
  runId?: string;
  taskId?: string;
  projectId?: string;
  agentRole?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  costUsd?: number;
  fallback?: boolean;
  /** Set for direct API calls (e.g. "google" for the Gemini router path); CLI rows derive it from engine. */
  provider?: string;
  /** How the call was paid for; CLI rows derive it from engine (see osUsageReport.ts). */
  authType?: "subscription" | "api_key" | "local" | "unknown";
}

// One client-facing outbound send (email or SMS), recorded for rate-limiting + quiet-hours (1.3/1.4).
// status "sent" rows are the rate-limit ledger; "queued" rows are held (quiet hours) for a flush job;
// "blocked" rows are cap/breaker refusals kept for the ops brief (never a silent drop).
export interface OutboundRecord {
  id: string;
  ts: ISO;
  channel: Channel;
  to: string;                 // recipient email or phone
  threadKey: string;          // rate-limit bucket: email threadId, or "sms:<phone>"
  clientId?: string;
  kind: string;               // "reply" | "review" | "notify" | "report" | ...
  status: "sent" | "queued" | "blocked";
  reason?: string;            // why queued/blocked
  sendAfterMs?: number;       // queued: earliest send instant (quiet-hours release)
  // Re-send payload (queued only): enough to fire the held message later via the raw transport.
  payload?: {
    subject?: string; body: string; cc?: string;
    replyToThreadId?: string; inReplyTo?: string; references?: string;
    account?: "owner" | "friday";
  };
}

// A human-handoff escalation. Raised when a client explicitly asks for a person / for the owner. While one
// is `open` for a client (and, for email, its thread), FRIDAY stops replying autonomously on that
// channel/thread — the owner takes over until they resolve it. See Artifact A (honesty/handoff floor).
export interface Escalation {
  id: string;
  clientId: string;
  channel: Channel;
  threadId?: string;        // email thread the handoff was requested on (scopes email suppression)
  reason?: string;          // short note (what they asked for)
  status: "open" | "resolved";
  createdAt: ISO;
  resolvedAt?: ISO;
  // --- while suppressed -------------------------------------------------------------------
  // An open escalation gags FRIDAY on every channel for this client and only `resume <name>`
  // clears it. These record what happened during the gag so it can never again be invisible:
  // Taylor sent a message into a 26-hour-old handoff and got total silence.
  suppressedCount?: number; // client messages swallowed by this escalation
  lastSuppressedAt?: ISO;
  lastNudgeAt?: ISO;        // last time the owner was re-paged about it
  clientAckedAt?: ISO;      // when the client was told a human is looping in (once per escalation)
}

// A user-defined RECURRING agent task — the scheduler fires it on its cadence, creating + dispatching
// a task to `assignee` on the target project(s). Distinct from Google-Calendar `schedule` events.
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  // Target: which project(s) each fire runs on.
  targetType: "project" | "client" | "all-active";
  projectId?: string;
  clientId?: string;
  // Task template (created fresh each fire; "{project}" in the title is substituted per project).
  assignee: string;      // agent role/id, e.g. "seo" | "qa" | "debug" | "support"
  title: string;
  description?: string;
  risk?: Risk;           // drives the approval gate at dispatch (default "low" → auto-runs)
  // Cadence — owner local time; the 60s scheduler tick gives ~1-minute precision.
  freq: "daily" | "weekly" | "monthly";
  dayOfWeek?: number;    // 0=Sun … 6=Sat (weekly)
  dayOfMonth?: number;   // 1-31 (monthly)
  hour: number;          // 0-23
  minute?: number;       // 0-59, default 0
  // State (updated by the driver job).
  lastRunAt?: ISO;
  lastRunId?: string;
  lastStatus?: string;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  role: AgentRole;
  engine: Engine;
  model?: string;
  systemPrompt?: string; // inline prompt (builtins) — imported agents lazy-load from `path`
  tools?: string[];
  skills?: string[];     // skill ids manually pinned to this agent
  color?: string;
  avatar?: string;
  active: boolean;       // on FRIDAY's active roster (imported start false → opt-in)
  source: AgentSource;
  sourceId?: string;     // which ImportSource it came from
  path?: string;         // source file for lazy body load (imported agents)
  type?: string;         // frontmatter "type"/category (analysis, devops, …)
  createdAt: ISO;
}

export type SkillKind = "skill" | "command" | "soul";

export interface Skill {
  id: string;
  name: string;
  description?: string;
  kind: SkillKind;
  source: AgentSource;
  sourceId?: string;     // which ImportSource it came from
  path?: string;         // source file — body is lazy-loaded from here
  body?: string;         // optional cached body (usually loaded on demand)
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  active: boolean;
  createdAt: ISO;
}

// A concrete deliverable produced by an agent run: a generated PDF report, a link to a
// GitHub PR, a code-change summary, or any other file. `path` = on-disk artifact served via
// /api/friday/artifact; `url` = an external link (e.g. a PR). One of path/url is set.
export interface Artifact {
  id: string;
  kind: "pdf" | "pr" | "summary" | "file";
  label: string;
  path?: string;   // absolute on-disk path (served, path-jailed, via /api/friday/artifact)
  url?: string;    // external link (PR, deploy, …) — for Drive-filed files this is the webViewLink
  driveFileId?: string; // Google Drive file id once filed (driveDeliverables.ts)
  mime?: string;
  createdAt: ISO;
}

export interface AgentRun {
  id: string;
  agentId: string;
  projectId?: string;
  taskId?: string;
  channel: Channel;
  input: string;
  status: "queued" | "running" | "awaiting_approval" | "done" | "error" | "cancelled";
  result?: string;
  summary?: string;        // short human recap of the result (for the feed + notify-back SMS)
  artifacts?: Artifact[];  // deliverables derived from the result (PDF, PR link, change summary)
  cwd?: string;            // where the agent actually ran (a PR-branch worktree for shepherd rounds)
  error?: string;
  // Which brain actually served this run (recorded after any failover — see engines.completeWithMeta).
  intendedEngine?: Engine; // the engine the assigned agent was supposed to run on
  servedEngine?: Engine;   // the engine that actually produced the result
  servedModel?: string;    // model used, when relevant (e.g. claude sonnet fallback)
  fellBack?: boolean;      // true if a failover occurred (intended !== served)
  verificationFailed?: boolean; // coding deliverable claimed but not verified against real git/gh state
  confidence?: number;     // 0..1 — how confident FRIDAY is the deliverable actually works (see verify.ts)
  verification?: { ran: boolean; passed: boolean; checks: { name: string; ok: boolean }[] }; // executed typecheck/build/test results
  live?: AgentRunLive; // compact live-progress snapshot (throttled) — full stream is in-memory (fridayLive)
  startedAt: ISO;
  endedAt?: ISO;
}

// A small, throttle-persisted snapshot of a run's live progress so plain /api/friday/runs polling can
// show a headline even without hitting the in-memory live registry. The rich stream (liveText +
// per-action timeline) lives in memory only (src/lib/fridayLive.ts), served by /api/friday/runs/[id]/live.
export interface AgentRunLive {
  headline?: string;       // "Writing src/foo.ts", "Running npm test", "Reviewing billingRoutes.ts"
  lastAction?: string;     // most recent tool/file/command target
  actionsCount?: number;   // how many tool actions so far
  bugCount?: number;       // QA/review: running count of blocker/bug/should-fix markers seen
  checking?: string;       // QA/review: file currently being inspected
  tokens?: number;         // cumulative token usage reported by the engine
  updatedAt?: ISO;
}

export interface Message {
  id: string;
  runId?: string;
  projectId?: string;
  /** Which client this turn belongs to, for client SMS/voice threads. Absent = owner or a
   *  pre-2026-08-19 row (from before per-client scoping existed) — NEVER treated as "any client"
   *  when reconstructing one client's short-term history; see clientChannel.ts's history filter. */
  clientId?: string;
  channel: Channel;
  role: "user" | "friday" | "agent" | "system";
  agentId?: string;
  text: string;
  ts: ISO;
}

export interface OrchestrationLog {
  id: string;
  ts: ISO;
  level: "info" | "warn" | "error";
  event: string;
  runId?: string;
  projectId?: string;
  data?: Record<string, unknown>;
}

export interface Approval {
  id: string;
  runId?: string;
  taskId?: string;
  projectId?: string;
  action: string;        // human-readable description of what will happen
  detail?: string;
  risk: Risk;
  // "expired" (2026-10-28, contract §3): the OS queue expired the ask after 48h with no decision.
  // It is NOT a reject — no reject side effects ran; the work simply wasn't approved.
  status: "pending" | "approved" | "rejected" | "expired";
  /** The OS approval-queue row id once the ask is raised there (the OS queue is the authority). */
  hubId?: string;
  hubRaisedAt?: ISO;
  /** Who decided, in words — "owner via clara/sms", "email", "web", "os" (2026-09-24). */
  decidedBy?: string;
  // Email-reply approvals: a client reply FRIDAY drafted (in `emailAccount`) that only SENDS on approval.
  emailDraftId?: string;
  emailAccount?: "owner" | "friday";
  emailClientId?: string; // client the reply is to — so the sent reply can be remembered on approval
  emailBody?: string;     // the drafted reply text — indexed to client memory once actually sent
  dedupeRef?: string;     // caller-supplied stable ref for the originating event (e.g. "meet:<conferenceRecord>") — queueEmailApproval's dup guard keys on it
  // The structured basis for the owner-facing copy (who asked, what for, the specifics). Optional
  // and additive — rows written before this existed deserialise fine and fall back to `action`.
  // Kept on the record so the UI card and any re-notify can render from facts rather than by
  // parsing `action` back apart.
  facts?: import("@/lib/friday/approvalCopy").ApprovalFacts;
  // State check (owner rule 2026-07-19): what already exists that this ask might duplicate — similar
  // open/recent-done tasks + matching recent commits — computed at queue time so the owner can reject
  // already-done work in one glance. Rendered verbatim in the approval email and the dashboard card.
  stateNote?: string;
  // ── Email-approval thread (the notification the owner REPLIES to — see approvalEmail.ts) ──
  notifyThreadId?: string;            // Gmail thread carrying this approval's conversation
  notifyAccount?: "owner" | "friday"; // which account sent it / which mailbox the poller reads
  notifySubject?: string;             // for "Re: …" threading of FRIDAY's follow-ups
  notifySentAt?: ISO;
  notifySeenMs?: number;              // newest owner-reply internalDate already processed
  notifyAttempts?: number;            // send-retry counter (capped — see sendApprovalEmail)
  // ── In-process Netlify deploy gate (deployProjectId set ⇒ approve fires the build) ──
  mergePrUrl?: string;               // PR the shepherd will merge when this (Tier-3) approval is approved
  mergeHeadSha?: string;             // the commit the owner was asked about; a yes holds for that commit only
  deployProjectId?: string;          // the project to deploy when this approval is approved
  deployClearCache?: boolean;        // whether the approved deploy should also purge the CDN cache
  // ── Intent-router gate (intentTool set ⇒ approve runs that tool) ──
  //
  // WITHOUT THIS FIELD the router could not safely queue anything. decideApprovalInner dispatches on
  // emailDraftId / deployProjectId / taskId; a row carrying none of them flips to "approved" and
  // does nothing at all, silently — so the owner would confirm an action that never ran and be told
  // "running it now". CLARA hit exactly this with her `generic` approval kind.
  intentTool?: string;                        // tool name from the router's catalog
  intentArgs?: Record<string, unknown>;       // the arguments it was called with
  // ── Delegated Authority stamps (Wave-1 #2, additive) ──
  authorityTier?: 1 | 2 | 3;           // what the policy said at queue time
  authorityMode?: "shadow" | "active"; // mode at queue time (absent = off / pre-authority row)
  authorityReason?: string;            // e.g. "task_dispatch × standard → tier 2"
  autoApproved?: boolean;              // true when ACTIVE authority took the approve click
  // ── Origin-aware autonomy stamps (2026-09, additive) ──
  requestOrigin?: RequestOrigin;       // who asked for the gated action (owner/clara/scheduler/client)
  scopeVerdict?: "in_scope" | "new" | "unknown"; // client asks only: was it inside the approved project scope?
  // ── Idempotency + supersedes (GAP-B-2 2026-07-23, ported from a sibling agent) ──
  idempotencyKey?: string;             // deterministic hash of side-effect identity; see idempotency.ts
  supersedes?: string;                 // approval id this row replaces (prior row aborted via CAS)
  executedAt?: ISO;                    // when the side effect fired (post-decision); enables idempotency window
  resultNote?: string;                 // human-readable side-effect outcome (esp. idempotent no-op reason)
  // Wave-2 Track B (2026-07-30): first-of-kind-then-auto format gating. Stamped at queue time by
  // callers whose approval releases a recurring CLIENT-FACING format (weekly_update / client_notify /
  // meeting_followup). A human approve of a format-stamped row GRANTS (clientId, formatKind) in the
  // format registry; later instances ride Tier 2. Absent = not format-gated (ad-hoc replies stay
  // hard Tier 3).
  formatKind?: string;
  // ── Aging-nudge stamps (Wave 4, 2026-07-30) ──
  // Set by the scheduler's approval-nudge job when this row was included in a consolidated SMS
  // nudge: nudged4hAt at the high/critical >4h crossing, nudged24hAt at the any-risk >24h crossing
  // (which also fires the threaded approval email as the aged reply-approve channel). Pure dedupe —
  // each threshold nudges a row at most once.
  nudged4hAt?: ISO;
  nudged24hAt?: ISO;
  requestedAt: ISO;
  decidedAt?: ISO;
}

// ── Format registry (Wave-2 Track B, 2026-07-30) ─────────────────────────────
// First-of-kind-then-auto for client-facing formats: the FIRST instance of each format per client
// gates (Tier 3); a human approve grants the (clientId, formatKind) pair, and later instances of
// that exact format ride Tier 2 (auto + digest note) once authority goes active. Revocable any time
// ("revoke <format> for <client>" over SMS, or POST /api/friday/authority). Independent of
// sibling agents' registries — the apps share no code or runtime surfaces (owner hard rule).
export interface FormatGrant {
  id: string;
  clientId: string;
  formatKind: string; // "weekly_update" | "client_notify" | "meeting_followup"
  status: "granted" | "revoked";
  grantedAt: ISO;
  grantedBy: "owner";
  grantedFromApprovalId: string; // the human-approved row that established the grant
  revokedAt?: ISO;
  revokedReason?: string;
  autoSendCount: number;   // how many sends rode this grant autonomously
  lastAutoSentAt?: ISO;
  createdAt: ISO;
  updatedAt: ISO;
}
