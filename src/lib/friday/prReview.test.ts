// prReview — reviewer-agnostic classification of CodeRabbit / Codex / human review threads, on the
// shapes GitHub actually returns (fixtures copied from live PRs on 2026-09-24).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleFeedback, classifyComment, severityOf, botOf, summarizeReviewBody, proposedFixOf, findingText, renderFindings, parseReviewBodyFindings, parseFindingOutcomes, composeBodyFindingReply, outcomeReply, coderabbitCovers, type RawThread } from "./prReview";

const CR_MAJOR = `_⚠️ Potential issue_ | _🟠 Major_

**Undelivered emergency is committed as delivered.**

When the CLARA escalation fails and email is also unavailable, the request is still acked.

<details>
<summary>🐛 Proposed fix</summary>

\`\`\`diff
-  return { ok: true };
+  if (!delivered) return { ok: false };
\`\`\`

</details>`;

const CR_MINOR = `_🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_

<details>
<summary>🔎 Supported by static analysis</summary>
🏁 Script executed:
\`\`\`bash
sed -n '60,80p' src/google/driveUpload.ts
\`\`\`
</details>

**Protect link tokens before applying emphasis.**

\`inline\` inserts \`<a>\` HTML before the emphasis substitutions.`;

const CR_TRIVIAL = `_🔵 Trivial_

**Prefer const.**`;

const CR_NIT = `🧹 Nitpick

Consider renaming \`x\` to \`count\`.`;

const CODEX_P1 = `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Reject malformed successful escalation responses**

When CLARA returns a 2xx response with an empty body, \`postJson\` produces \`null\` and this expression reports \`ok: true\`.

Useful? React with 👍 / 👎.`;

const CODEX_P2 = `**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  postStatus accepts {ok:true}**

Validate the shape.`;

const CODEX_P3 = `**<sub><sub>![P3 Badge](https://img.shields.io/badge/P3-green?style=flat)</sub></sub>  Typo in comment**`;

const thread = (author: string, body: string, over: Partial<RawThread> = {}): RawThread => ({
  id: `T_${Math.random().toString(36).slice(2, 8)}`, isResolved: false, isOutdated: false, path: "src/a.ts", line: 10,
  comments: { nodes: [{ id: "C1", databaseId: 123, author: { login: author }, body, diffHunk: "@@ -1,3 +1,3 @@\n-a\n+b" }] },
  ...over,
});

test("bot detection by login", () => {
  assert.equal(botOf("coderabbitai"), "coderabbit");
  assert.equal(botOf("coderabbitai[bot]"), "coderabbit");
  assert.equal(botOf("chatgpt-codex-connector[bot]"), "codex");
  assert.equal(botOf("netlify[bot]"), "other");
  assert.equal(botOf("example-org"), null);
});

test("severity: CodeRabbit headers, Codex badges, nitpicks, humans", () => {
  assert.equal(severityOf(CR_MAJOR, "coderabbit"), "major");
  assert.equal(severityOf(CR_MINOR, "coderabbit"), "minor");
  assert.equal(severityOf(CR_TRIVIAL, "coderabbit"), "trivial");
  assert.equal(severityOf(CR_NIT, "coderabbit"), "trivial");
  assert.equal(severityOf(CODEX_P1, "codex"), "major");
  assert.equal(severityOf(CODEX_P2, "codex"), "minor");
  assert.equal(severityOf(CODEX_P3, "codex"), "trivial");
  assert.equal(severityOf("This breaks the login page on mobile.", null), "unknown");
});

test("actionable = unresolved, on current code, severe enough; trivial/resolved/outdated are not", () => {
  assert.equal(classifyComment({ author: "coderabbitai", body: CR_MAJOR, isResolved: false, isOutdated: false }).actionable, true);
  assert.equal(classifyComment({ author: "coderabbitai", body: CR_MINOR, isResolved: false, isOutdated: false }).actionable, true);
  assert.equal(classifyComment({ author: "chatgpt-codex-connector", body: CODEX_P2, isResolved: false, isOutdated: false }).actionable, true);
  assert.equal(classifyComment({ author: "example-org", body: "please fix", isResolved: false, isOutdated: false }).actionable, true);
  assert.equal(classifyComment({ author: "chatgpt-codex-connector", body: CODEX_P3, isResolved: false, isOutdated: false }).actionable, false);
  assert.equal(classifyComment({ author: "coderabbitai", body: CR_NIT, isResolved: false, isOutdated: false }).reason, "trivial");
  assert.equal(classifyComment({ author: "coderabbitai", body: CR_MAJOR, isResolved: true, isOutdated: false }).reason, "resolved");
  assert.equal(classifyComment({ author: "coderabbitai", body: CR_MAJOR, isResolved: false, isOutdated: true }).reason, "outdated");
});

test("proposed fix and finding text are extracted from the boilerplate", () => {
  assert.match(proposedFixOf(CR_MAJOR) ?? "", /return \{ ok: false \}/);
  assert.equal(proposedFixOf(CODEX_P1), undefined);
  const t = findingText(CODEX_P1);
  assert.doesNotMatch(t, /Badge|Useful\?/);
  assert.match(t, /Reject malformed successful escalation responses/);
  assert.doesNotMatch(findingText(CR_MINOR), /Script executed/);
});

test("summaries: no actionable, skipped, actionable count, bot vs human CHANGES_REQUESTED", () => {
  assert.equal(summarizeReviewBody("coderabbitai", "No actionable comments were generated in the recent review. 🎉").kind, "no_actionable");
  assert.equal(summarizeReviewBody("coderabbitai", "**Review skipped**\n\nReview skipped due to path filters").kind, "skipped");
  const a = summarizeReviewBody("coderabbitai", "**Actionable comments posted: 4**\n\n---", "COMMENTED", "724d44661e");
  assert.equal(a.kind, "actionable"); assert.equal(a.count, 4); assert.equal(a.commit, "724d44661e");
  assert.equal(summarizeReviewBody("coderabbitai", "Pre-merge checks failed", "CHANGES_REQUESTED").kind, "changes_requested");
  const codex = summarizeReviewBody("chatgpt-codex-connector[bot]", "| 📝 **Code Review** | ✅ **Completed** | `69ef1fa` | PR opened |");
  assert.equal(codex.commit, "69ef1fa");
});

test("assembleFeedback: actionable vs skipped, human block, bot coverage by head sha", () => {
  const head = "69ef1facca141e31641e48d8c95b0860616ddb79";
  const fb = assembleFeedback({
    headSha: head,
    threads: [thread("coderabbitai", CR_MAJOR), thread("chatgpt-codex-connector", CODEX_P3), thread("coderabbitai", CR_MINOR, { isResolved: true }), thread("example-org", "This needs a null check.")],
    reviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", body: "**Actionable comments posted: 1**", commit: { oid: head } }],
    issueComments: [{ user: { login: "chatgpt-codex-connector[bot]" }, body: "| 📝 **Code Review** | ✅ **Completed** | `69ef1fa` | PR opened |" }],
  });
  assert.equal(fb.actionable.length, 2);
  assert.deepEqual(fb.actionable.map((c) => c.severity), ["major", "unknown"]);
  assert.equal(fb.skipped.length, 1);
  assert.equal(fb.humanChangesRequested, false);
  assert.equal(fb.botReviewPending, false);
  assert.ok(fb.botReviewedShas.includes(head.toLowerCase()) || fb.botReviewedShas.includes("69ef1fa"));

  const pending = assembleFeedback({ headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", threads: [], reviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", body: "**Actionable comments posted: 0**", commit: { oid: head } }], issueComments: [] });
  assert.equal(pending.botReviewPending, true, "a review of an older sha does not cover the new head");

  const humanNo = assembleFeedback({ headSha: head, threads: [], reviews: [{ author: { login: "example-org" }, state: "CHANGES_REQUESTED", body: "not yet", commit: { oid: head } }], issueComments: [] });
  assert.equal(humanNo.humanChangesRequested, true);
  assert.equal(humanNo.humanChangesRequestedBy, "example-org");
  const humanThenOk = assembleFeedback({ headSha: head, threads: [], reviews: [
    { author: { login: "example-org" }, state: "CHANGES_REQUESTED", body: "not yet", commit: { oid: "1" } },
    { author: { login: "example-org" }, state: "APPROVED", body: "ok now", commit: { oid: head } },
  ], issueComments: [] });
  assert.equal(humanThenOk.humanChangesRequested, false, "a later approval clears the block");
  const botNo = assembleFeedback({ headSha: head, threads: [], reviews: [{ author: { login: "coderabbitai" }, state: "CHANGES_REQUESTED", body: "Pre-merge checks failed", commit: { oid: head } }], issueComments: [] });
  assert.equal(botNo.humanChangesRequested, false, "a bot's CHANGES_REQUESTED is informational");

  const skippedOnly = assembleFeedback({ headSha: head, threads: [], reviews: [], issueComments: [{ user: { login: "coderabbitai[bot]" }, body: "Review skipped due to path filters" }] });
  assert.equal(skippedOnly.botReviewPending, true, "a sha-less bot summary does NOT cover the head");
  assert.equal(skippedOnly.coderabbitReviewedHead, false);
  assert.equal(skippedOnly.coderabbitPresent, true, "but it proves CodeRabbit is installed");
  assert.equal(coderabbitCovers({ coderabbitCheck: "absent" }, skippedOnly), false);

  const codexOnly = assembleFeedback({ headSha: head, threads: [], reviews: [{ author: { login: "chatgpt-codex-connector[bot]" }, state: "COMMENTED", body: "reviewed", commit: { oid: head } }], issueComments: [] });
  assert.equal(codexOnly.coderabbitReviewedHead, false, "a Codex review is not CodeRabbit coverage");
  assert.equal(coderabbitCovers({ coderabbitCheck: "absent" }, codexOnly), false);
  assert.equal(fb.coderabbitReviewedHead, true, "a CodeRabbit review on the head sha covers it");
});

test("coverage: the CodeRabbit status context passing on the head covers it; pending/absent/fail do not", () => {
  const none = { coderabbitReviewedHead: false };
  assert.equal(coderabbitCovers({ coderabbitCheck: "pass" }, none), true);
  for (const c of ["pending", "absent", "fail"] as const) assert.equal(coderabbitCovers({ coderabbitCheck: c }, none), false, c);
});

const OUTSIDE_DIFF = readFileSync(join(process.cwd(), "src/lib/friday/__fixtures__/coderabbit-review-outside-diff.md"), "utf8");

test("outside-diff findings in a CodeRabbit review body are parsed (real friday#29 body)", () => {
  const f = parseReviewBodyFindings(OUTSIDE_DIFF);
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((x) => x.key), ["cr:fcc89cd0831f94540f9932b5", "cr:c3bbe134d929280972b43254", "cr:3236957db8dec0173f5661fe"]);
  assert.equal(f[0].path, "src/lib/friday/delivery.ts");
  assert.equal(f[0].line, 323);
  assert.equal(f[0].severity, "major");
  assert.match(f[0].title, /Keep PR worktrees when the remote check fails/);
  assert.match(f[0].body, /ls-remote/);

  const head = "69ef1facca141e31641e48d8c95b0860616ddb79";
  const fb = assembleFeedback({ headSha: head, threads: [], reviews: [
    { author: { login: "coderabbitai" }, state: "COMMENTED", body: OUTSIDE_DIFF, commit: { oid: "1111111" } },
    { author: { login: "coderabbitai" }, state: "COMMENTED", body: OUTSIDE_DIFF, commit: { oid: head } },
  ], issueComments: [] });
  const body = fb.actionable.filter((c) => c.source === "review-body");
  assert.equal(body.length, 3, "the same finding in two reviews counts once");
  assert.ok(body.every((c) => c.bot === "coderabbit" && c.key?.startsWith("cr:")));
  assert.match(renderFindings(body), /outside the diff/);
});

test("nitpick/trivial findings in a review body are skipped", () => {
  const nit = [
    "**Actionable comments posted: 0**",
    "<details>",
    "<summary>🧹 Nitpick comments (1)</summary><blockquote>",
    "<details>",
    "<summary>src/x.ts (1)</summary><blockquote>",
    "`68-68`: _🧹 Nitpick_ | _🔵 Trivial_",
    "**Rename x.**",
    "</blockquote></details>",
    "</blockquote></details>",
  ].join("\n");
  assert.equal(parseReviewBodyFindings(nit).length, 0);
  const fb = assembleFeedback({ headSha: "abc", threads: [], reviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", body: nit, commit: { oid: "abc" } }], issueComments: [] });
  assert.equal(fb.actionable.length, 0);
});

test("the agent's FIXED/DECLINED list drives the replies; declined findings carry the reason", () => {
  const o = parseFindingOutcomes("Done.\n\nFIXED F1\n- DECLINED F2: ls-remote already uses --exit-code here\nsome trailing text");
  assert.deepEqual(o.get("F1"), { fixed: true });
  assert.equal(o.get("F2")?.fixed, false);
  assert.equal(o.get("F2")?.reason, "ls-remote already uses --exit-code here");
  const reply = composeBodyFindingReply([
    { label: "F1", path: "src/lib/friday/delivery.ts", line: 323, title: "Keep PR worktrees" },
    { label: "F2", path: "src/lib/friday/delivery.ts", line: 329, title: "Protect ignored files" },
    { label: "F3", path: "src/a.ts", title: "Unlisted" },
  ], o, "abcdef1234567");
  assert.match(reply, /^@coderabbitai /);
  assert.match(reply, /delivery\.ts:323.*Addressed in abcdef1/);
  assert.match(reply, /delivery\.ts:329.*Declined: ls-remote already uses --exit-code here/);
  assert.match(reply, /src\/a\.ts.*Still open/, "a finding missing from the list is never reported as addressed");
  assert.doesNotMatch(reply, /src\/a\.ts.*Addressed/);
  assert.match(reply, /Please review the latest changes/);
});

test("renderFindings gives the fix agent path:line, severity, finding, hunk and proposed fix within budget", () => {
  const fb = assembleFeedback({ headSha: "abc", threads: [thread("coderabbitai", CR_MAJOR, { path: "src/lib/notify.ts", line: 201 })], reviews: [], issueComments: [] });
  const out = renderFindings(fb.actionable);
  assert.match(out, /^src\/lib\/notify\.ts:201 — \[major\] \(coderabbitai\)/);
  assert.match(out, /Undelivered emergency/);
  assert.match(out, /Context:/);
  assert.match(out, /Proposed fix:/);
  const many = Array.from({ length: 40 }, () => thread("coderabbitai", CR_MAJOR));
  const big = renderFindings(assembleFeedback({ headSha: "abc", threads: many, reviews: [], issueComments: [] }).actionable, 3000);
  assert.ok(big.length < 3600);
  assert.match(big, /more findings not shown/);
});


test("a finding with no FIXED/DECLINED outcome is not handled: no reply, so its thread stays open", () => {
  const o = parseFindingOutcomes("FIXED F1\nDECLINED F2: already guarded upstream");
  assert.equal(outcomeReply("F1", o, "abcdef1234567"), "Addressed in abcdef1.");
  assert.equal(outcomeReply("F2", o, "abcdef1234567"), "Declined: already guarded upstream");
  assert.equal(outcomeReply("F3", o, "abcdef1234567"), null, "missing outcome → null → leave the thread unresolved");
  assert.equal(outcomeReply(undefined, o, "abcdef1234567"), null, "an unlabelled thread is never auto-resolved");
  assert.equal(outcomeReply("F1", parseFindingOutcomes("Done, all fixed."), "abc"), null, "no closing list at all → nothing handled");
});

test("coverage: a pending or failed CodeRabbit status is never overridden by a review object", () => {
  const reviewed = { coderabbitReviewedHead: true };
  assert.equal(coderabbitCovers({ coderabbitCheck: "pending" }, reviewed), false, "Review in progress");
  assert.equal(coderabbitCovers({ coderabbitCheck: "fail" }, reviewed), false);
  assert.equal(coderabbitCovers({ coderabbitCheck: "absent" }, reviewed), true, "no status context: the review object is the evidence");
});

test("coverage: a CodeRabbit thread reply (empty-bodied review on the head) is not a review", () => {
  const head = "2fae1f9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reply = assembleFeedback({ headSha: head, threads: [], reviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", body: "", commit: { oid: head } }], issueComments: [] });
  assert.equal(reply.coderabbitReviewedHead, false);
  assert.equal(coderabbitCovers({ coderabbitCheck: "absent" }, reply), false);
});
