// FRIDAY — reviewer-agnostic PR review reader (PR shepherd, 2026-09-24).
//
// CodeRabbit and Codex both review every PR in the client repos; humans occasionally do. Nothing in
// FRIDAY read any of it before this module, so review findings sat unresolved while the owner was
// asked to "merge + deploy". The shepherd needs three things from a PR's review state:
//   * which comments are ACTIONABLE (unresolved, on the current code, severe enough to matter) — those
//     become a `[Review Rn]` fix round on the PR branch;
//   * whether a HUMAN has requested changes — a hard block that goes to the owner's email, never
//     silently overridden;
//   * whether CodeRabbit has reviewed the EXACT current head (owner rule 2026-09-25: nothing merges
//     without a CodeRabbit review of the code that lands; Codex is welcome but doesn't substitute);
//   * CodeRabbit findings that live in review BODIES ("Outside diff range comments", per-file
//     <details> blocks) rather than inline threads — those are actionable too.
// Reading is GraphQL (review threads carry resolved/outdated state; REST doesn't) plus REST issue
// comments for the bots' summaries. Writing is limited to replies + thread resolution + one
// "@coderabbitai review" nudge. Everything here is best-effort: a gh failure yields an empty
// feedback object with `fetchOk:false`, and the shepherd treats that as "wait", never as "clean".

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Severity = "critical" | "major" | "minor" | "trivial" | "unknown";
export type ReviewBot = "coderabbit" | "codex" | "other" | null;

export interface ReviewComment {
  id: string;            // GraphQL node id of the first comment in the thread
  databaseId?: number;   // REST id (for replies)
  threadId?: string;     // GraphQL review-thread id (for resolveReviewThread)
  author: string;
  bot: ReviewBot;
  path?: string;
  line?: number;
  body: string;
  diffHunk?: string;
  severity: Severity;
  isResolved: boolean;
  isOutdated: boolean;
  proposedFix?: string;
  /** "thread" = inline review thread (reply + resolve); "review-body" = a finding inside a CodeRabbit
   *  review body (answered in one PR comment, remembered by `key`). */
  source?: "thread" | "review-body";
  /** Stable identity for a review-body finding (CodeRabbit's cr-comment id, else path:line:title). */
  key?: string;
  title?: string;
  /** Short handle (F1, F2, …) the fix agent uses to report FIXED/DECLINED per finding. */
  label?: string;
}

export interface ReviewSummary {
  author: string;
  bot: ReviewBot;
  kind: "no_actionable" | "skipped" | "actionable" | "changes_requested" | "other";
  count?: number;
  commit?: string;       // the head sha this summary/review covers, when the bot says
  state?: string;        // review state when it came from a review object
}

export interface ReviewFeedback {
  fetchOk: boolean;
  headSha: string;
  actionable: ReviewComment[];
  skipped: ReviewComment[];   // trivial / nitpick threads FRIDAY resolves with a note
  summaries: ReviewSummary[];
  humanChangesRequested: boolean;
  humanChangesRequestedBy?: string;
  /** No CodeRabbit review object covers the current head (commit.oid === head). Strict: a sha-less
   *  summary comment is NOT coverage. The shepherd also accepts the CodeRabbit status context passing
   *  on the head (PrReadiness.coderabbitCheck), and decides how long to wait. */
  botReviewPending: boolean;
  /** A CodeRabbit review object exists for exactly the current head sha. */
  coderabbitReviewedHead: boolean;
  /** CodeRabbit has left anything at all on this PR (review, thread or comment). */
  coderabbitPresent: boolean;
  /** Head shas that bot reviews/summaries cover (for tests and logging). */
  botReviewedShas: string[];
}

// ── Pure classification ─────────────────────────────────────────────────────

const BOT_LOGIN: Array<{ re: RegExp; bot: ReviewBot }> = [
  { re: /^coderabbitai(\[bot\])?$/i, bot: "coderabbit" },
  { re: /^chatgpt-codex-connector(\[bot\])?$/i, bot: "codex" },
  { re: /\[bot\]$/i, bot: "other" },
];

export function botOf(login: string): ReviewBot {
  for (const b of BOT_LOGIN) if (b.re.test(login.trim())) return b.bot;
  return null;
}

const CR_SEVERITY = /_(?:🔴|🟠|🟡|🔵)\s*(Critical|Major|Minor|Trivial)_/i;
const CODEX_BADGE = /!\[P([123]) Badge\]/;
const NITPICK = /🧹\s*Nitpick/i;
const PROPOSED_FIX = /<summary>\s*(?:🐛\s*)?(?:Proposed|Suggested) fix\s*<\/summary>\s*([\s\S]*?)<\/details>/i;

export function severityOf(body: string, bot: ReviewBot): Severity {
  if (NITPICK.test(body)) return "trivial";
  const cr = body.match(CR_SEVERITY);
  if (cr) return cr[1].toLowerCase() as Severity;
  const cx = body.match(CODEX_BADGE);
  if (cx) return cx[1] === "1" ? "major" : cx[1] === "2" ? "minor" : "trivial";
  if (bot === null) return "unknown"; // a human comment: treated as major (someone took the time)
  return "unknown";
}

const ACTIONABLE_SEVERITIES = new Set<Severity>(["critical", "major", "minor", "unknown"]);

export function classifyComment(c: { author: string; body: string; isResolved: boolean; isOutdated: boolean }): { bot: ReviewBot; severity: Severity; actionable: boolean; reason: string } {
  const bot = botOf(c.author);
  const severity = severityOf(c.body, bot);
  if (c.isResolved) return { bot, severity, actionable: false, reason: "resolved" };
  if (c.isOutdated) return { bot, severity, actionable: false, reason: "outdated" };
  if (!ACTIONABLE_SEVERITIES.has(severity)) return { bot, severity, actionable: false, reason: "trivial" };
  return { bot, severity, actionable: true, reason: severity };
}

/** Extract the fenced diff/code from a CodeRabbit "Proposed fix" block, when present. */
export function proposedFixOf(body: string): string | undefined {
  const m = body.match(PROPOSED_FIX);
  if (!m) return undefined;
  const fence = m[1].match(/```[a-z]*\n([\s\S]*?)```/);
  return (fence ? fence[1] : m[1]).trim().slice(0, 4000) || undefined;
}

/** Strip the reviewers' boilerplate (badges, details blocks, "Useful? React…") to the finding itself. */
export function findingText(body: string): string {
  return body
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/<sub><sub>!\[P\d Badge\][^<]*<\/sub><\/sub>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^_[^_\n]*_\s*(\|\s*_[^_\n]*_\s*)*$/gm, "")
    .replace(/Useful\? React with .*$/gim, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Classify a bot review body / summary issue comment. */
export function summarizeReviewBody(author: string, body: string, state?: string, commit?: string): ReviewSummary {
  const bot = botOf(author);
  const b = body || "";
  let kind: ReviewSummary["kind"] = "other";
  let count: number | undefined;
  const m = b.match(/Actionable comments posted:\s*(\d+)/i);
  if (/No actionable comments/i.test(b)) kind = "no_actionable";
  else if (/Review skipped/i.test(b) || /Files ignored due to path filters/i.test(b) && !m) kind = "skipped";
  else if (m) { count = Number(m[1]); kind = count > 0 ? "actionable" : "no_actionable"; }
  if ((state ?? "").toUpperCase() === "CHANGES_REQUESTED") kind = "changes_requested";
  // Codex summaries carry the reviewed commit in a table cell; CodeRabbit reviews carry commit.oid.
  const cm = commit ?? (b.match(/\|\s*`([0-9a-f]{7,40})`\s*\|/)?.[1]) ?? (b.match(/Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/)?.[1]);
  return { author, bot, kind, count, commit: cm, state };
}

// ── CodeRabbit review-body findings ─────────────────────────────────────────
//
// CodeRabbit can't post comments outside the diff inline, so it lists them in the review body:
//   > **⚠️ Outside diff range comments (N)**
//   > <details><summary><em>🟠 Major</em> · Title · <code>file.ts:323</code></summary><blockquote>
//   > `src/lib/x/file.ts:323`
//   > _🗄️ Category_ | _🟠 Major_ | _⚡ Quick win_
//   > **Title.** … body …
//   > <!-- cr-comment:v1:HASH --> </blockquote></details>
// Older reviews use per-file <details><summary>path (n)</summary> blocks with `123-130`: items. Both
// are parsed; nitpick sections are trivial and ignored (they never block).

export interface BodyFinding { key: string; path?: string; line?: number; title: string; body: string; severity: Severity }

const FINDING_SEVERITY = /(?:🔴|🟠|🟡|🔵)\s*(Critical|Major|Minor|Trivial)/i;

export function parseReviewBodyFindings(raw: string): BodyFinding[] {
  if (!raw) return [];
  const body = raw.split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n");
  const out: BodyFinding[] = [];
  const seen = new Set<string>();
  const push = (f: BodyFinding) => { if (!seen.has(f.key)) { seen.add(f.key); out.push(f); } };
  // Section boundaries: everything after an "Outside diff range comments" header up to the fix prompt
  // / review info footer. Nitpick sections are excluded on purpose.
  const sections: string[] = [];
  const re = /Outside diff range comments?\s*\(\d+\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const rest = body.slice(m.index);
    const end = rest.search(/🧹\s*Nitpick|<!-- autofix_checkbox_start|🤖 Prompt to fix review comments|ℹ️ Review info|\n---\n/);
    sections.push(end > 0 ? rest.slice(0, end) : rest);
  }
  for (const sec of sections) {
    // New format: one <details> per finding with the location in the summary.
    const item = /<summary>\s*(?:<em>)?([^<]*?)(?:<\/em>)?\s*·\s*([\s\S]*?)\s*·\s*<code>([^<]+?)<\/code>\s*<\/summary>([\s\S]*?)<\/blockquote>\s*<\/details>/g;
    let it: RegExpExecArray | null;
    let matched = false;
    while ((it = item.exec(sec))) {
      matched = true;
      const [, sevText, title, loc, inner] = it;
      const lm = loc.match(/^(.*?):(\d+)(?:-\d+)?$/);
      const full = (inner.match(/`([^`\s]+):(\d+)(?:-\d+)?`/));
      const path = full ? full[1] : lm ? lm[1] : loc;
      const line = Number(full ? full[2] : lm ? lm[2] : NaN);
      const sev = (inner.match(CR_SEVERITY)?.[1] ?? sevText.match(FINDING_SEVERITY)?.[1] ?? "unknown").toLowerCase() as Severity;
      const id = inner.match(/cr-comment:v1:([0-9a-f]+)/)?.[1];
      const clean = title.replace(/<[^>]+>/g, "").trim();
      push({ key: id ? `cr:${id}` : `loc:${path}:${line || 0}:${clean.slice(0, 60)}`, path, line: Number.isFinite(line) ? line : undefined, title: clean, body: inner.trim(), severity: sev });
    }
    if (matched) continue;
    // Older format: per-file <details><summary>path (n)</summary> … `L1-L2`: _cat_ | _🟠 Major_ … items.
    const fileBlock = /<summary>([^<(]+?)\s*\(\d+\)<\/summary>\s*<blockquote>([\s\S]*?)<\/blockquote>\s*<\/details>/g;
    let fb: RegExpExecArray | null;
    while ((fb = fileBlock.exec(sec))) {
      const path = fb[1].trim();
      for (const chunk of fb[2].split(/\n-{3,}\n/)) {
        const lm = chunk.match(/`(\d+)(?:-\d+)?`\s*:/);
        if (!lm) continue;
        const sev = (chunk.match(CR_SEVERITY)?.[1] ?? "unknown").toLowerCase() as Severity;
        const title = (chunk.match(/\*\*([^*]+)\*\*/)?.[1] ?? "finding").trim();
        const id = chunk.match(/cr-comment:v1:([0-9a-f]+)/)?.[1];
        push({ key: id ? `cr:${id}` : `loc:${path}:${lm[1]}:${title.slice(0, 60)}`, path, line: Number(lm[1]), title, body: chunk.trim(), severity: sev });
      }
    }
  }
  return out;
}

export interface RawThread { id: string; isResolved: boolean; isOutdated: boolean; path?: string | null; line?: number | null; comments: { nodes: Array<{ id: string; databaseId?: number; author?: { login: string } | null; body: string; diffHunk?: string | null }> } }
export interface RawReview { author?: { login: string } | null; state: string; body?: string | null; commit?: { oid: string } | null }
export interface RawIssueComment { user?: { login: string } | null; body?: string | null }

/** Pure assembly from the raw GraphQL/REST shapes — fixture-tested. */
export function assembleFeedback(input: { headSha: string; threads: RawThread[]; reviews: RawReview[]; issueComments: RawIssueComment[]; fetchOk?: boolean }): ReviewFeedback {
  const actionable: ReviewComment[] = [];
  const skipped: ReviewComment[] = [];
  for (const t of input.threads) {
    const first = t.comments?.nodes?.[0];
    if (!first) continue;
    const author = first.author?.login ?? "unknown";
    const cls = classifyComment({ author, body: first.body ?? "", isResolved: t.isResolved, isOutdated: t.isOutdated });
    const c: ReviewComment = {
      id: first.id, databaseId: first.databaseId, threadId: t.id, author, bot: cls.bot,
      path: t.path ?? undefined, line: typeof t.line === "number" ? t.line : undefined,
      body: first.body ?? "", diffHunk: first.diffHunk ?? undefined, severity: cls.severity,
      isResolved: t.isResolved, isOutdated: t.isOutdated, proposedFix: proposedFixOf(first.body ?? ""),
      source: "thread",
    };
    if (cls.actionable) actionable.push(c);
    else if (cls.reason === "trivial") skipped.push(c);
  }
  const summaries: ReviewSummary[] = [];
  let humanChangesRequested = false;
  let humanChangesRequestedBy: string | undefined;
  // Newest human review state wins (a later APPROVED clears an earlier CHANGES_REQUESTED).
  const humanLatest = new Map<string, string>();
  for (const r of input.reviews) {
    const author = r.author?.login ?? "unknown";
    summaries.push(summarizeReviewBody(author, r.body ?? "", r.state, r.commit?.oid));
    if (botOf(author) === null) humanLatest.set(author, (r.state ?? "").toUpperCase());
  }
  for (const [who, state] of humanLatest) if (state === "CHANGES_REQUESTED") { humanChangesRequested = true; humanChangesRequestedBy = who; }
  let coderabbitPresent = input.threads.some((t) => botOf(t.comments?.nodes?.[0]?.author?.login ?? "") === "coderabbit");
  for (const c of input.issueComments) {
    const author = c.user?.login ?? "unknown";
    if (botOf(author) === "coderabbit") coderabbitPresent = true;
    if (botOf(author) !== "coderabbit" && botOf(author) !== "codex") continue;
    summaries.push(summarizeReviewBody(author, c.body ?? ""));
  }
  // Findings inside CodeRabbit review bodies (outside-diff comments). Every CodeRabbit review is read
  // — an incremental review of a later head doesn't repeat earlier ones — and the shepherd filters
  // out the ones it has already answered (PrState.handledFindingKeys).
  const bodyKeys = new Set<string>();
  for (const r of input.reviews) {
    const author = r.author?.login ?? "unknown";
    if (botOf(author) !== "coderabbit") continue;
    coderabbitPresent = true;
    for (const f of parseReviewBodyFindings(r.body ?? "")) {
      if (bodyKeys.has(f.key) || !ACTIONABLE_SEVERITIES.has(f.severity)) continue;
      bodyKeys.add(f.key);
      actionable.push({
        id: f.key, key: f.key, author, bot: "coderabbit", path: f.path, line: f.line, body: f.body, title: f.title,
        severity: f.severity, isResolved: false, isOutdated: false, proposedFix: proposedFixOf(f.body), source: "review-body",
      });
    }
  }
  const head = input.headSha.toLowerCase();
  const sameSha = (s: string) => !!s && !!head && (head === s || (s.length >= 7 && head.startsWith(s)));
  const botReviewedShas = [...new Set(summaries.filter((s) => s.bot === "coderabbit" || s.bot === "codex").map((s) => (s.commit ?? "").toLowerCase()).filter(Boolean))];
  // Coverage is CodeRabbit-only and sha-exact: a review OBJECT whose commit is the head. Summary
  // comments without a commit, and Codex reviews, never count (owner rule 2026-09-25). A review with
  // an empty body is CodeRabbit replying in a thread — GitHub files the reply as a review on the
  // newest commit, but nothing was reviewed (agent-core#10 merged unreviewed on one, 2026-10-09).
  const coderabbitReviewedHead = input.reviews.some((r) =>
    botOf(r.author?.login ?? "") === "coderabbit" && sameSha((r.commit?.oid ?? "").toLowerCase()) && !!(r.body ?? "").trim());
  return {
    fetchOk: input.fetchOk ?? true, headSha: input.headSha, actionable, skipped, summaries, humanChangesRequested, humanChangesRequestedBy,
    botReviewPending: !coderabbitReviewedHead, coderabbitReviewedHead, coderabbitPresent, botReviewedShas,
  };
}

// ── GitHub I/O (gh CLI, ambient auth) ───────────────────────────────────────

async function gh(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const THREADS_QUERY = `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ headRefOid reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:10){ nodes{ id databaseId author{login} body diffHunk } } } } reviews(last:30){ nodes{ author{login} state body commit{oid} } } } } }`;

export async function fetchReviewFeedback(owner: string, repo: string, n: number): Promise<ReviewFeedback> {
  try {
    const raw = await gh(["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${owner}`, "-F", `r=${repo}`, "-F", `n=${n}`]);
    const pr = (JSON.parse(raw) as { data?: { repository?: { pullRequest?: { headRefOid: string; reviewThreads: { nodes: RawThread[] }; reviews: { nodes: RawReview[] } } } } }).data?.repository?.pullRequest;
    if (!pr) throw new Error("no pullRequest in response");
    let issueComments: RawIssueComment[] = [];
    try {
      issueComments = JSON.parse(await gh(["api", `repos/${owner}/${repo}/issues/${n}/comments?per_page=100`])) as RawIssueComment[];
    } catch { /* summaries are a nice-to-have */ }
    return assembleFeedback({ headSha: pr.headRefOid, threads: pr.reviewThreads?.nodes ?? [], reviews: pr.reviews?.nodes ?? [], issueComments, fetchOk: true });
  } catch {
    return { fetchOk: false, headSha: "", actionable: [], skipped: [], summaries: [], humanChangesRequested: false, botReviewPending: true, coderabbitReviewedHead: false, coderabbitPresent: false, botReviewedShas: [] };
  }
}

export async function resolveThread(threadId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const raw = await gh(["api", "graphql", "-f", `query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`, "-F", `id=${threadId}`]);
    const ok = /"isResolved":\s*true/.test(raw);
    return ok ? { ok } : { ok: false, error: raw.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).slice(0, 200) };
  }
}

export async function replyToThread(owner: string, repo: string, n: number, commentId: number, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await gh(["api", `repos/${owner}/${repo}/pulls/${n}/comments/${commentId}/replies`, "-f", `body=${body}`]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).slice(0, 200) };
  }
}

/** Ask CodeRabbit for a fresh pass (it re-reviews on push anyway; this covers a stalled one). */
export async function requestBotReview(owner: string, repo: string, n: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await gh(["api", `repos/${owner}/${repo}/issues/${n}/comments`, "-f", "body=@coderabbitai review"]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).slice(0, 200) };
  }
}

/** An empty feedback object for PRs the shepherd doesn't need to read reviews for this pass. */
export function emptyFeedback(headSha: string): ReviewFeedback {
  return { fetchOk: true, headSha, actionable: [], skipped: [], summaries: [], humanChangesRequested: false, botReviewPending: false, coderabbitReviewedHead: false, coderabbitPresent: false, botReviewedShas: [] };
}

/** Post one PR (issue) comment — used to answer CodeRabbit's review-body findings in one place. */
export async function postPrComment(owner: string, repo: string, n: number, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await gh(["api", `repos/${owner}/${repo}/issues/${n}/comments`, "-f", `body=${body}`]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: string }).stderr || e).slice(0, 200) };
  }
}

const repoCrCache = new Map<string, { at: number; value: boolean | null }>();
/** Has CodeRabbit ever commented on this repo's pull requests? true / false / null (couldn't tell).
 *  Cached 6 h per repo. Used only to tell "not installed" from "hasn't got to this PR yet". */
export async function repoHasCodeRabbit(owner: string, repo: string, now = Date.now()): Promise<boolean | null> {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = repoCrCache.get(key);
  if (hit && now - hit.at < 6 * 60 * 60_000) return hit.value;
  let value: boolean | null = null;
  try {
    const out = await gh(["api", `repos/${owner}/${repo}/issues/comments?per_page=100&sort=created&direction=desc`, "--jq", "[.[].user.login] | map(select(test(\"coderabbit\"))) | length"]);
    const n = Number(out.trim());
    if (Number.isFinite(n)) value = n > 0;
    if (value === false) {
      const rv = await gh(["api", `repos/${owner}/${repo}/pulls/comments?per_page=100&sort=created&direction=desc`, "--jq", "[.[].user.login] | map(select(test(\"coderabbit\"))) | length"]);
      if (Number(rv.trim()) > 0) value = true;
    }
  } catch { value = null; }
  repoCrCache.set(key, { at: now, value });
  return value;
}

// ── FIXED / DECLINED outcomes from a review round ───────────────────────────

export interface FindingOutcome { fixed: boolean; reason?: string }

/** Parse the fix agent's closing list: `FIXED F3` / `DECLINED F2: reason`. Pure. */
export function parseFindingOutcomes(text: string): Map<string, FindingOutcome> {
  const out = new Map<string, FindingOutcome>();
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^\s*[-*]?\s*(FIXED|DECLINED)\s+\[?(F\d+)\]?\s*(?::\s*(.*))?$/i);
    if (!m) continue;
    out.set(m[2].toUpperCase(), m[1].toUpperCase() === "FIXED" ? { fixed: true } : { fixed: false, reason: (m[3] ?? "").trim() || "judged not applicable to the current code" });
  }
  return out;
}

/** Reply text for one finding, or null when the fix agent recorded no outcome for it. A finding
 *  without an explicit FIXED/DECLINED is NOT handled: it stays open (inline thread unresolved,
 *  body finding not remembered) so the next round picks it up. Fail closed. Pure. */
export function outcomeReply(label: string | undefined, outcomes: Map<string, FindingOutcome>, sha: string): string | null {
  const o = label ? outcomes.get(label) : undefined;
  if (!o) return null;
  return o.fixed ? `Addressed in ${sha.slice(0, 7)}.` : `Declined: ${o.reason}`;
}

/** The single PR comment answering CodeRabbit's review-body findings after a round. Findings with
 *  no recorded outcome are listed as still open, never as addressed. Pure. */
export function composeBodyFindingReply(items: Array<{ label: string; path?: string; line?: number; title?: string }>, outcomes: Map<string, FindingOutcome>, sha: string): string {
  const lines = items.map((f) => {
    const where = `${f.path ?? "(general)"}${f.line ? `:${f.line}` : ""}`;
    const what = outcomeReply(f.label, outcomes, sha) ?? "Still open — no fix recorded yet; I'll take it up in the next round.";
    return `- \`${where}\` — ${f.title ?? "finding"}: ${what}`;
  });
  return [`@coderabbitai Replies to the findings outside the diff from your last review (FRIDAY):`, "", ...lines, "", `Please review the latest changes.`].join("\n");
}

/** Resolve the trivial/nitpick threads with a one-line note so they never block a merge. */
export async function dismissTrivial(owner: string, repo: string, n: number, skipped: ReviewComment[]): Promise<number> {
  let done = 0;
  for (const c of skipped) {
    if (c.databaseId) await replyToThread(owner, repo, n, c.databaseId, "Noted — not blocking; left as is.").catch(() => {});
    if (c.threadId && (await resolveThread(c.threadId)).ok) done++;
  }
  return done;
}

/** Render the actionable findings for a fix agent: path:line — [severity] finding + hunk + fix. */
export function renderFindings(comments: ReviewComment[], budget = 6000): string {
  const parts: string[] = [];
  let used = 0;
  for (const c of comments) {
    const where = c.source === "review-body" ? " (review summary, outside the diff)" : "";
    const head = `${c.label ? `[${c.label}] ` : ""}${c.path ?? "(general)"}${c.line ? `:${c.line}` : ""} — [${c.severity}] (${c.author})${where}`;
    const text = findingText(c.body).slice(0, 1500);
    const hunk = c.diffHunk ? `\nContext:\n\`\`\`\n${c.diffHunk.slice(0, 800)}\n\`\`\`` : "";
    const fix = c.proposedFix ? `\nProposed fix:\n\`\`\`\n${c.proposedFix.slice(0, 1200)}\n\`\`\`` : "";
    const block = `${head}\n${text}${hunk}${fix}`;
    if (used + block.length > budget) { parts.push(`(+${comments.length - parts.length} more findings not shown — read them on the PR)`); break; }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

// ── Review coverage (shared by the client-PR shepherd and the internal-repo rules) ──
/** Ask CodeRabbit for a review once per head after this long without one. */
export const BOT_NUDGE_AFTER_MS = 15 * 60_000;
/** After a fix round pushed and replied, nudge sooner. */
export const BOT_NUDGE_AFTER_ROUND_MS = 10 * 60_000;
/** Stop waiting and tell the owner: nothing merges unreviewed. */
export const BOT_GIVE_UP_WAIT_MS = 2 * 60 * 60_000;

/**
 * True only when CodeRabbit reviewed the EXACT head: its status context passed on the head commit,
 * or one of its reviews was submitted against the head sha. A sha-less summary comment, an older
 * review, or a Codex review does not count. Pure.
 */
export function coderabbitCovers(pr: { coderabbitCheck: "pass" | "fail" | "pending" | "absent" }, review: Pick<ReviewFeedback, "coderabbitReviewedHead">): boolean {
  // The status context is authoritative when CodeRabbit posts one: "Review in progress" (pending) or
  // a failed check means not covered, whatever review objects exist. The review-object fallback is
  // only for repos/runs where no status context is posted.
  if (pr.coderabbitCheck === "pass") return true;
  if (pr.coderabbitCheck === "pending" || pr.coderabbitCheck === "fail") return false;
  return review.coderabbitReviewedHead === true;
}
