# FRIDAY — Complete Tool/Integration Inventory

Compiled 2026-08-10 by direct code inspection (not from memory/docs). Every entry below is tagged
with a file:line. Where something could not be fully confirmed as *live* (vs. merely configured),
that's flagged explicitly rather than presented as active.

## 1. Main Intent-Router Tool Catalog (`TOOLS`)

**File:** `src/lib/friday/intent.ts:60-435` — the actual catalog. `intentCli.ts`
(`src/lib/friday/intentCli.ts:1-129`) is just the wire adapter that serializes this same `TOOLS`
array into a JSON-contract prompt for the Claude-CLI brain (`cliCaller`); `anthropicCaller`
(agent-core) uses it directly when `ANTHROPIC_API_KEY` is set (`intent.ts:477`). Both brains see
**the same 11 tools** — one catalog, not two.

| Tool name | Does | actionClass / gating | Location |
|---|---|---|---|
| `project_status` | Reads active projects, open tasks, running runs, pending approvals; summarizes | `other`, reversible (auto-runs) | intent.ts:62-91 |
| `list_projects` | Lists projects + client, optional name filter | `other`, reversible | intent.ts:93-116 |
| `site_health` | Reads uptime state + per-client health report, flags down sites | `other`, reversible | intent.ts:118-135 |
| `client_health` | Per-client task/deliverable/uptime/deploy detail | `other`, reversible | intent.ts:137-155 |
| `dep_sweep` | Checks client repos for outdated/vulnerable deps; dry-run by default | `other`, reversible | intent.ts:157-178 |
| `dispatch_task` | Creates a new Task on a project for an agent to pick up | `task_dispatch` — Tier 1 for owner/CLARA asks under the origin policy (legacy: Tier 1/2 only under `standard`/`aggressive` profile) | intent.ts:180-215 |
| `deploy` | Ships a project to production via Netlify | `deploy`, irreversible — origin policy: Tier 1 for owner/CLARA asks (runs with `force` under `FRIDAY_AUTHORITY=active`, queues under shadow/off); legacy policy: hard Tier-3 floor | intent.ts:217-244 |
| `weekly_update` | Sends weekly progress update to clients | `weekly_update` — irreversible (reaches clients), floored high | intent.ts:246-271 |
| `provision_workspace` | Creates a new GitHub repo + Netlify site | `other`, irreversible (real remote resources) | intent.ts:273-301 |
| `create_doc` | Writes a new Google Doc (proposals/SOWs/briefs/recaps) into **FRIDAY's own Drive**, private, not shared | `other`, reversible — recently added | intent.ts:328-355 |
| `drive_search` | Searches the owner's Google Drive by filename | `other`, reversible, read-only | intent.ts:357-383 |
| `recent_meetings` | Lists recent Google Meet calls + transcripts | `other`, reversible, read-only | intent.ts:385-410 |
| `find_contact` | Looks someone up in the owner's Google Contacts (incl. "other contacts") | `other`, reversible, read-only | intent.ts:412-434 |

**Explicitly NOT present (confirmed removed, not just absent):** `search_mail`,
`read_email_thread`, `list_calendar`, `find_free_slot`. Code comment states these existed until
**2026-08-05** and were deliberately deleted because CLARA is the sole owner of the owner's
mailbox/calendar (intent.ts:303-322). The system prompt (intent.ts:456-461) reinforces this at
runtime: FRIDAY is told to redirect calendar/inbox questions to CLARA and never answer from memory.
This stripping is confirmed correctly wired — no calendar/mailbox tool is reachable from the router.

**Caveat:** FRIDAY's Google OAuth token *does* carry gmail/calendar scopes (§3) — those back
scheduled automation (§2), not this router. Real distinction, not a contradiction.

### Delegation / inter-agent tooling
**None found.** No tool hands a request to CLARA programmatically. The only mechanism
is the system prompt telling FRIDAY to say, in prose, "that's CLARA's — ask her" (intent.ts:456-461).
No inter-agent RPC/tool call exists in this codebase.

### Approval / bypass tooling exposed to the router
**None.** The `TOOLS` array has no approve/reject/set-authority-tier tool callable by the model.
Approval decisions go through a **separate deterministic command parser** over SMS/voice/email —
`ownerCommands.ts` (e.g. `"approve #3F2A"`, `"reject"`, `"revoke <format> for <client>"`) and the
mirrored email-reply classifier in `approvalEmail.ts`. `gate()` and `queueApproval()` in the
intent adapter (intent.ts) are internal plumbing the LLM never calls directly. Since 2026-09 the
gate runs reversible tools, and for irreversible ones asks `evaluateAuthority` with the origin taken
from `ctx.principal` (`owner` ⇒ owner, `clara` ⇒ clara): Tier ≥ 3 or a non-`active` mode ⇒ queue an
approval (stamped `requestOrigin`); otherwise `{ decision: "run", force: true }` — agent-core's
`IntentGate.force` is the adapter vouching that its own authority model waived the row.

## 2. Google Workspace (wrapper functions, mostly automation not chat)

- **Gmail** (`google/gmail.ts`): `sendEmail`, `getSignature`, `getProfile`, `getMessageBody`, `getAttachmentData`, `createDraft`, `sendDraft`, `deleteDraft`, `getThreadDetail`, `getThread`, `searchMessages`
- **Calendar** (`google/calendar.ts`): `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `freeBusy`, `firstFreeSlot`
- **Meet** (`google/meet.ts`): `listRecentMeetings` — also exposed as chat tool `recent_meetings`
- **People** (`google/people.ts`): `searchContacts` — also exposed as chat tool `find_contact`
- **Drive** (`google/drive.ts`): `listFiles`, `findFolder`, `createFolder`, `ensureFolder`, `listFolderFiles`, `downloadFileBytes`, `exportFileBytes`, `trashFile`, `ensureClientFolder`, `uploadTextFile`, `uploadBinaryFile`, `moveFile`, `readFileText` — `listFiles` also exposed as `drive_search`
- **Docs** (`google/docs.ts`): `createDoc`, `shareDoc` — only `createDoc` is exposed to chat (`shareDoc` deliberately withheld — sending stays gated)
- **Library** (`google/library.ts`): client/project deliverable-folder provisioning helpers

Used heavily by scheduled automation (intent.ts:316-319): `emailAgent` (inbox triage),
`approvalEmail` (approval reply watch), `clientNotify`, `meetingPrep`, `weeklyUpdate`,
`clientReview`, `feedback`, `stallCheckin`, `boardHygiene`'s Drive sync, `delivery-cal` (calendar
milestone events) — see §7 job list. The gmail/calendar scopes exist **because of this automation
layer**, not because chat can reach a mailbox.

## 3. Google OAuth Scopes

**File:** `src/lib/friday/google/auth.ts:30-46`.

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/meetings.space.readonly
https://www.googleapis.com/auth/contacts.readonly
https://www.googleapis.com/auth/contacts.other.readonly
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
openid
```

**Nuance worth stating plainly:** the OAuth client *does* hold `gmail.modify`/`gmail.send` and full
`calendar` scopes — broader than a strict reading of "FRIDAY doesn't do email/calendar" suggests.
Not a stripping failure: these back the scheduled email/calendar *automation* (inbox triage,
approval-reply watching, delivery-milestone events, meeting prep), while the **conversational tool
catalog** has zero gmail/calendar tools (removed 2026-08-05). "Can a chat request make FRIDAY
read/send the owner's personal mail" → no (no reachable tool). "Does her OAuth grant include
mailbox/calendar write access" → yes, by design, for the automation layer.

Two connected Google accounts share this scope set: `"owner"` (the owner's, read for automation) and
`"friday"` (her own Workspace account, used for client replies and `create_doc` output) —
google/auth.ts:18-22.

## 4. MCP Servers

### Root project config — `.mcp.json`
Auto-loaded by any plain `claude -p` invocation run from FRIDAY's cwd — her general planner/dev-brain
calls in `engines.ts`, **not** the intent-router (`intentCli.ts` uses pure JSON tools, no real MCP).

| Server | Transport | Purpose |
|---|---|---|
| `orion` | HTTP (`http://127.0.0.1:3100/mcp`, Bearer JWT via `ORION_JWT`) | Orion CRM/OS — 470 tools on the server, but FRIDAY's allowlist restricts her to **`FRIDAY_OS_TOOLS`**, ~90 tools scoped to Engineering (projects, project tasks, opportunities, contacts w/o merge/delete, files/Drive, workflows/automation, AI-agent config, integrations w/o connect/credential tools, forms, read-only reporting, agent-tasks/approvals-bridge family). Full list: `node_modules/@autom8ionlab/agent-core/src/osmcp/allowlists.ts:35-89`. **Important:** the allowlist comment states this is the *primary* department boundary — RLS does not enforce it server-side for most tables (only payments/invoices/forms/reviews/workflows do). |
| `repomix` | stdio (`npx -y repomix --mcp`) | Codebase packing/summarization tool |

> `ruflo` (ruvnet/claude-flow) was removed from this file and from the codebase on 2026-09-14 after it was tied to a malware incident; `mcpConfig.test.ts` fails the build if it reappears.

**Uncertain — flagged:** `completeClaude`/`streamClaude` (engines.ts:255-272, 277-318) don't pass
`--dangerously-skip-permissions` unless `opts.write` is true, and don't pass an explicit
`--allowedTools` for the non-OS path. Without an allowlist or skip-permissions, headless `-p` mode
typically refuses to actually invoke tool calls — so repomix being *registered* doesn't
necessarily mean they're *invokable* on a routine non-write completion, only on `write:true`
coding-role dispatches. The Orion server is the one with a deliberate allowlist path
(`osWiring()`, engines.ts:232-253), gated additionally by `osEnabled()` — i.e. FRIDAY having
completed her one-time OS sign-in (osClient.ts:44-46); whether that sign-in has been
completed depends on the install.

No other `.mcp.json` or programmatic MCP-client instantiation exists anywhere else in `src/`.

## 5. Other Third-Party Integrations

| Integration | Used for | Access pattern |
|---|---|---|
| **GitHub** | Repo provisioning, owner/repo discovery, PR state/merge | In-process, authenticated `gh` CLI, shell:false (workspace.ts:14-49, 237-301) — not MCP for the general case |
| **Netlify** | Site creation, triggering/polling deploys, cache purge, site settings, deploy history | In-process REST wrapper, `NETLIFY_AUTH_TOKEN` (workspace.ts:52-187) |
| **Supabase** | Creating new client Supabase projects (general provisioning) | In-process Management API wrapper, `SUPABASE_ACCESS_TOKEN` (workspace.ts:189-219) |
| **Twilio** | Owner/client SMS, inbound SMS webhook, outbound calls, signature verification | In-process REST wrapper, `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN`/`FROM_NUMBER` (channels.ts:20-139) |
| **ElevenLabs** | Confirmed present — TTS for phone calls (`elevenTTSAudio`, `elevenTTS`), used by call TwiML and the TTS route. Default voice "Rachel." Falls back to Amazon Polly if `FRIDAY_PUBLIC_URL` unset. | In-process REST wrapper, `ELEVENLABS_API_KEY` (env or `~/.hermes/.env` fallback) (channels.ts:1-3, 141-204) |
| **Cloudflare** | Not an integration — only mentioned in a comment (channels.ts:94) noting Twilio's public webhook paths bypass Cloudflare Access. No Cloudflare API is called anywhere in FRIDAY's code. |
| **LM Studio** | Local/offline failover brain (OpenAI-compatible, `:1234`) | In-process HTTP, no external secrets (engines.ts:194-227) |
| **Codex CLI** | Independent code-review/verification pass plus a general DevOps/QA/debug brain option | Spawned CLI subprocess, sandboxed (engines.ts:335-392) |

All of these except GitHub-via-`gh`/Codex/Claude are called through in-process TypeScript wrappers
using plain `fetch` — secrets stay in FRIDAY's Node process and are never handed to a spawned CLI
subprocess (`runner.ts`'s `SECRET_ENV_DENYLIST` strips them from ambient env inheritance when a CLI
child is spawned).

## 6. Task/Approval Management (internal, not model-facing tools)

- `authority.ts` — 3-tier autonomy. Default **origin policy** (`decideAutonomy`, dial `autonomy_policy=origin`):
  owner/CLARA/scheduler-origin ⇒ Tier 1; client-origin ⇒ Tier 1 only in approved scope; critical
  risk, the self-edit gate and money language (`risk.ts` `MONEY_STOP`) ⇒ Tier 3 for every origin.
  `evaluateAuthority` wraps it; the master switch is `FRIDAY_AUTHORITY=off|shadow|active` (dial
  `authority`, default shadow). `autonomy_policy=legacy` = the old `classifyActionTier` ×
  `applyRiskFloor` table + format lane.
- Approval creators and where origin comes from: `queueApproval` (task dispatch — `task.requestOrigin`,
  else inferred; scope from the task's Request), `queueEmailApproval` (email — `requestOrigin`
  `scheduler` for FRIDAY's timed formats, `client` + reply scope for commitment replies),
  `queueDeployApproval` (deploy — `origin` from the chat/planner/dashboard caller; auto-approves Tier 1
  under `active`), the intent gate (above), and `maybeAutoQA` (QA-passed work merges + deploys when
  origin-policy Tier 1 under `active`; the bypass carve-out is a subset). Every approval row carries
  `requestOrigin` and, for client asks, `scopeVerdict` (`in_scope`/`new`/`unknown`).
- Portal (`osTickets.ts`): in-scope `cr_ack` / `cr_completed_reply` / bug-ticket acks post directly
  (`[ack-posted]` internal marker) when active + `client_comms=on` + authority `active`/origin;
  out-of-scope CRs still park via `portal_cr_scope_approval`.
- `taskIntake.ts` — the single-client `bypassPolicy` autonomy carve-out (below)
- `ownerCommands.ts` — SMS/voice/email approve/reject grammar (short-code addressed, no ordinals)
- Scheduler jobs `approval-expiry`, `approval-nudge` — auto-reject stale approvals, escalate aged ones

### bypassPolicy — single-client autonomy carve-out
Fields: `Client.bypassPolicy?: { enabled, grantedAt, reason }` (types.ts:68),
`Task.bypassAuthority?: boolean` (types.ts:168). Gating chain, all must pass:
1. Global kill switch `FRIDAY_CLIENT_BYPASS=on` (default off) — taskIntake.ts:138-140
2. `Client.bypassPolicy.enabled === true` on that specific client record — taskIntake.ts:207
3. Risk must not be `high`/`critical` — taskIntake.ts:208
4. Hard content stop regex blocks delete/drop/wipe/charge/payment/invoice/refund/payout/wire/transfer/bank-account/credit-card/`rm -rf` language — taskIntake.ts:146, 209
5. Daily cap (`FRIDAY_CLIENT_BYPASS_DAILY_CAP`, default 5), ledger-tracked, pages owner once on cap-hit — taskIntake.ts:148-188
6. Channel/identity checks (email path never qualifies via loose name matching) — taskIntake.ts:199-210

When eligible, the task is stamped `bypassAuthority: true` and `orchestrator.ts:maybeAutoQA`
(1373-1395) skips the normal approval queue entirely, including deploy — the one deliberate
exception to "every deploy gates behind `queueDeployApproval`." Owner gets a low-priority FYI, never
a blocking approval.

## 7. Scheduled/Autonomous Tasks (`scheduler.ts` `JOBS`)

Single `setInterval` heartbeat (60s tick), started once at boot, killable via
`FRIDAY_SCHEDULERS=off`.

| id | Cadence | Does |
|---|---|---|
| `stale-handoff-sweep` | 1h | Pages owner about open human-escalation handoffs sitting unresolved |
| `os-agent-tasks-poll` | 1min | Pulls due work from Orion (gated `FRIDAY_OS_TASKS`) |
| `os-approvals-bridge` | 1min | Mirrors/pulls approval decisions to/from Orion hub |
| `notify-digest` | 1h | Flushes batched low-priority notifications |
| `memory-reindex` | 5min | Embeds missed messages/runs for recall |
| `morning-brief` | daily after 7am | Texts owner the daily brief |
| `client-docs-drive-sync` | daily after 7am | Syncs client Drive "Documents" folders |
| `feedback-watch` | 5min | Polls "how'd we do" reply threads |
| `board-hygiene` | daily after 8am | Auto-merges near-duplicate planning cards |
| `meeting-watcher` | 15min | Polls Meet transcripts → auto-creates tasks. **Off by default** (`FRIDAY_MEETING_WATCHER=on` to enable) — CLARA digests meetings |
| `inbox-triage` | 15min | Triages client email, auto-replies routine, drafts commitments for approval |
| `approval-email-watch` | 2min | Reads owner's approval-reply emails, acts on them |
| `client-review-watch` | 2min | Reads client replies in review threads |
| `outbound-flush` | 5min | Sends messages held for client quiet hours |
| `review-silence-nudge` | daily after 9am | Day-3 nudge / day-7 auto-close on silent reviews |
| `meeting-prep-watch` | 10min | Pre-meeting briefing email, 75min lookahead |
| `weekly-client-update` | daily after 2pm, Fridays only | Weekly client check-in emails |
| `pr-watcher` | 10min | Marks tasks "completed" when their PR merges |
| `stale-nudge` | daily after 8am | Flags overdue projects / stuck tasks |
| `delivery-cal` | daily after 6am | Puts project target-delivery dates on calendar |
| `uptime` | 10min | Pings deploy URLs, flap-damped down/up alerts |
| `lmstudio-watch` | 10min | Self-heals the local LM Studio brain |
| `engine-auth-watch` | 30min | Alerts on engine auth lapse/recovery (codex + lmstudio always; claude too when `AGENTIC_OS_DEEP_AUTH_PROBE=1`) |
| `scheduled-agent-tasks` | 1min | Fires user-defined recurring agent schedules, budget/spend-capped |
| `usage-summary` | daily after 6pm | Daily run-count digest |
| `stall-checkin` | daily after 9am | Drafts nudges to gone-quiet clients (`FRIDAY_STALL_CHECKIN`, default shadow) |
| `dep-sweep-weekly` | daily after 6am, Weds only | Dependency patch-bump sweep (`FRIDAY_DEP_SWEEP`, default shadow) |
| `approval-expiry` | 30min | Auto-rejects stale pending approvals (risk-scaled window) |
| `approval-nudge` | 30min | SMS/email nudge for aged pending approvals |

---

## Summary: confirmed inactive/stripped vs. active

- **Confirmed removed, not reachable:** `search_mail`, `read_email_thread`, `list_calendar`, `find_free_slot` — deleted 2026-08-05, no trace in the current `TOOLS` array.
- **Confirmed still granted (nuance, not a bug):** gmail.modify/send + full calendar OAuth scopes remain, backing scheduled automation only.
- **Confirmed no inter-agent delegation tool** — CLARA handoff is prose-only via system prompt.
- **Confirmed no approval/autonomy tool in the chat catalog** — separate SMS/voice/email command grammar.
- **Uncertain/flagged:** whether the repomix MCP tools are actually invokable on non-write completions given the permission-mode gap in §4; whether FRIDAY's one-time Orion sign-in has been completed (`osEnabled()` gate) on a given install.
