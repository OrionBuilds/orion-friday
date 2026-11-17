// Tests for the pure half of the client-portal update pipeline: the noise classifier, feature-area
// naming, the plain-English validator, and the deterministic fallback (which must always pass the
// validator — it is the last line of defence when the LLM is down or keeps leaking jargon).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUnit, featureAreaOf, featureAreas, sectionIssues, fallbackEntry, sectionsToText, humanizeTitle, CAPS,
  type WorkUnit, type ChangedFile,
} from "./portalUpdateCopy";

const f = (path: string, additions = 5, deletions = 2): ChangedFile => ({ path, additions, deletions, status: "modified" });
const unit = (over: Partial<WorkUnit>): WorkUnit => ({
  kind: "pr", ref: "pr#1", title: "feat(landers): video hero, form in a modal", body: "", commits: [{ sha: "a1b2c3d4e5f", subject: "video hero", body: "" }],
  files: [f("src/components/funnel/PaidLander.tsx", 120, 30)], occurredAt: "2026-09-21T15:00:00Z", ...over,
});

// ── classifier ──────────────────────────────────────────────────────────────

test("lockfile-only and deps-only changes are noise", () => {
  assert.deepEqual(classifyUnit(unit({ files: [f("package-lock.json")] })), { noise: true, reason: "lockfile", kind: "maintenance" });
  const deps = classifyUnit(unit({ title: "chore(deps): weekly patch bumps (2026-09-19)", files: [f("package.json"), f("package-lock.json", 400, 400)] }));
  assert.equal(deps.noise, true);
  assert.equal(deps.reason, "deps");
});

test("CI/config-only changes are noise", () => {
  const c = classifyUnit(unit({ title: "Fix failing CI checks", files: [f(".github/workflows/ci.yml"), f("netlify.toml")] }));
  assert.equal(c.noise, true);
  assert.equal(c.reason, "ci");
});

test("build/tooling scripts are noise (mai-dash PR #77/#79 shape)", () => {
  const c = classifyUnit(unit({ title: "Fix test suite failing on platform-mismatched esbuild binary", files: [f("package.json"), f("scripts/ensure-esbuild.cjs"), f("lib/scripts/ensure-esbuild.test.ts")] }));
  assert.equal(c.noise, true);
  assert.equal(featureAreaOf("scripts/seed.ts"), null);
});

test("globex PR #21 style TypeScript revert (config + lockfile) is noise", () => {
  const c = classifyUnit(unit({ title: "revert: pin TypeScript back to 5.9 so the Netlify build passes", files: [f("package.json"), f("package-lock.json"), f("tsconfig.json")] }));
  assert.equal(c.noise, true);
});

test("a product revert that touches real components is NOT noise and is a fix", () => {
  const c = classifyUnit(unit({ title: "revert(forms): put the GHL embeds back", files: [f("src/components/forms/LeadForm.tsx")] }));
  assert.deepEqual(c, { noise: false, kind: "fix" });
});

test("a feature that also bumps the lockfile is still a feature", () => {
  const c = classifyUnit(unit({ files: [f("src/components/funnel/PaidLander.tsx"), f("package-lock.json")] }));
  assert.deepEqual(c, { noise: false, kind: "feature" });
});

test("title-only classification when no files are available", () => {
  assert.equal(classifyUnit(unit({ files: [], title: "chore(deps): weekly patch bumps", commits: [] })).noise, true);
  assert.equal(classifyUnit(unit({ files: [], title: "Fix failing CI checks", commits: [] })).noise, true);
  assert.equal(classifyUnit(unit({ files: [], title: "put the lead form on the first screen", commits: [] })).noise, false);
});

test("content-only changes are kind=content", () => {
  assert.deepEqual(classifyUnit(unit({ title: "new hero photos", files: [f("public/images/hero.jpg"), f("content/home.md")] })), { noise: false, kind: "content" });
});

// ── feature areas ───────────────────────────────────────────────────────────

test("paths map to names a client recognises", () => {
  assert.equal(featureAreaOf("apps/web/app/(app)/calls/[id]/page.tsx"), "Calls");
  assert.equal(featureAreaOf("src/components/funnel/PaidLander.tsx"), "Funnel");
  assert.equal(featureAreaOf("src/components/PaidLander.tsx"), "Paid Landing Page");
  assert.equal(featureAreaOf("globex.example-audit/findings/seo.md"), null);
  assert.equal(featureAreaOf("globex.example-audit/audit-data.json"), null);
  assert.equal(featureAreaOf("supabase/migrations/0032_add_leads.sql"), "Data storage");
  assert.equal(featureAreaOf("supabase/functions/client-portal-auth/index.ts"), "Background service: Client Portal Sign-in");
  assert.equal(featureAreaOf("src/app/api/leads/route.ts"), "Leads (behind the scenes)");
  assert.equal(featureAreaOf("src/lib/utils/format.ts"), "Shared logic (behind the scenes)");
  assert.equal(featureAreaOf("src/app/page.tsx"), "Home page");
  assert.equal(featureAreaOf("src/app/pricing/page.tsx"), "Pricing");
  assert.equal(featureAreaOf("src/app/gads/insurance-claim/page.tsx"), "Google Ads › Insurance Claim");
  assert.equal(featureAreaOf("public/images/hero.jpg"), "Site content and images");
  assert.equal(featureAreaOf("package-lock.json"), null);
  assert.equal(featureAreaOf(".github/workflows/ci.yml"), null);
});

test("featureAreas aggregates by churn and drops housekeeping", () => {
  const areas = featureAreas([f("src/components/funnel/PaidLander.tsx", 100, 10), f("src/components/funnel/Hero.tsx", 5, 1), f("src/app/pricing/page.tsx", 20, 0), f("package-lock.json", 900, 900)]);
  assert.deepEqual(areas.map((a) => a.area), ["Funnel", "Pricing"]);
  assert.equal(areas[0].files, 2);
});

// ── validator ───────────────────────────────────────────────────────────────

const clean = {
  title: "Faster ad landing pages with a simpler form",
  sections: {
    context: "You asked us to make the paid-ad landing page load faster and make it easier for visitors to reach the form.",
    changes: "We rebuilt the landing page so the video plays at the top, moved the contact form into a pop-up, and added a quiet bot check so junk submissions stop reaching you.",
    impact: "Visitors arriving from your ads now see the video first and can open the form with one tap. The Leads page will show fewer spam entries.",
    live_now: "This change is live on your site now.",
    check: ["Open the paid-ad landing page on your phone and tap the button to open the form."],
  },
};

test("a clean, plain-English entry passes", () => {
  assert.deepEqual(sectionIssues(clean, "live"), []);
});

test("engineering leaks are rejected", () => {
  const bad = (patch: Partial<typeof clean.sections>, title = clean.title) => sectionIssues({ title, sections: { ...clean.sections, ...patch } }, "live");
  assert.ok(bad({ changes: "We updated src/components/funnel/PaidLander.tsx to render the modal." }).some((i) => /file path/.test(i)));
  assert.ok(bad({ context: "This closes the work tracked in PR #45 for the landing page rebuild." }).some((i) => /PR\/issue/.test(i)));
  assert.ok(bad({ changes: "We merged the friday/landers branch into the main branch after the checks passed." }).some((i) => /branch|jargon/.test(i)));
  assert.ok(bad({ changes: "We upgraded to TypeScript 6.0.3 for the build and cleaned up the bundle configuration." }).some((i) => /version|jargon/.test(i)));
  assert.ok(bad({ changes: "Claude wrote the new hero section and FRIDAY reviewed it before it went out." }).some((i) => /agent/.test(i)));
  assert.ok(bad({ impact: "You will not notice anything; this is a refactor of the internal API." }).some((i) => /jargon/.test(i)));
  assert.ok(bad({ live_now: "This will ship soon." }).some((i) => /live_now/.test(i)));
  assert.ok(bad({}, "Fix").some((i) => /title/.test(i)));
});

test("pending mode requires 'not live yet' wording and rejects live claims", () => {
  assert.ok(sectionIssues(clean, "pending").some((i) => /live_now/.test(i)));
  const pending = { ...clean, sections: { ...clean.sections, live_now: "This is built and waiting for your go-ahead before it goes live; it is not live yet." } };
  assert.deepEqual(sectionIssues(pending, "pending"), []);
});

// ── fallback ────────────────────────────────────────────────────────────────

test("humanizeTitle scrubs prefixes, PR suffixes and dev words", () => {
  assert.equal(humanizeTitle("feat(landers): video hero, form in a modal, Turnstile bot gate on Call + form (#12)"), "Video hero, form in a modal, Turnstile bot gate on Call + form");
  assert.equal(humanizeTitle("chore(deps): weekly patch bumps (2026-09-19)"), "Weekly patch bumps (2026 09 19)");
  assert.equal(humanizeTitle("friday/fix-r1-deps-build-2026-08-07"), "Fix r1 build 2026 08 07");
});

test("the deterministic fallback always passes the validator, even for ugly titles", () => {
  const titles = [
    "chore(deps): weekly patch bumps (2026-09-19)",
    "friday/fix r1 deps build 2026 08 07",
    "feat(landers): video hero, form in a modal, Turnstile bot gate on Call + form (#12)",
    "Merge branch 'friday' into main",
    "fix",
    "revert: pin TypeScript back to 5.9.2 so the Netlify build passes (#21)",
    "a1b2c3d",
  ];
  for (const title of titles) {
    for (const files of [[f("src/components/funnel/PaidLander.tsx")], [] as ChangedFile[], [f("package-lock.json")]]) {
      for (const mode of ["live", "pending"] as const) {
        const u = unit({ title, files, request: title.startsWith("fix") ? { asked: "make the contact form work on phones again", by: "Eli" } : undefined });
        const e = fallbackEntry(u, { projectName: "Globex", mode }, "feature");
        assert.deepEqual(sectionIssues(e, mode), [], `title="${title}" files=${files.length} mode=${mode}: ${JSON.stringify(e)}`);
      }
    }
  }
});

test("digest headline comes from the most descriptive commit, never 'N changes on <date>'", () => {
  const u = unit({
    kind: "commit-digest", title: "3 changes on 2026-09-21",
    commits: [
      { sha: "1", subject: "chore(deps): bump", body: "" },
      { sha: "2", subject: "put the lead form on the first screen, not below the hero", body: "" },
      { sha: "3", subject: "fix typo", body: "" },
    ],
  });
  const e = fallbackEntry(u, { projectName: "Globex", mode: "live" }, "feature");
  assert.match(e.title, /^Put the lead form on the first screen/);
  assert.doesNotMatch(e.title, /changes on/);
  assert.deepEqual(sectionIssues(e, "live"), []);
});

test("behind-the-scenes areas are never offered as something to open and check", () => {
  const u = unit({ files: [f("src/lib/utils/format.ts", 200, 50), f("supabase/migrations/1.sql", 30, 0), f("src/app/pricing/page.tsx", 10, 2)] });
  const e = fallbackEntry(u, { projectName: "Globex", mode: "live" }, "feature");
  assert.deepEqual(e.sections.check, ["Open Pricing and confirm it looks and behaves the way you expect."]);
  assert.match(e.sections.impact, /Pricing/);
  assert.doesNotMatch(e.sections.impact, /behind the scenes/);
  const only = fallbackEntry(unit({ files: [f("src/lib/utils/format.ts")] }), { projectName: "Globex", mode: "live" }, "feature");
  assert.match(only.sections.impact, /behind-the-scenes change/);
  assert.deepEqual(only.sections.check, []);
});

test("fallback uses the request context and names feature areas", () => {
  const e = fallbackEntry(unit({ request: { asked: "put the lead form on the first screen", by: "Eli" } }), { projectName: "Globex", mode: "live" }, "feature");
  assert.match(e.sections.context, /You asked us to put the lead form on the first screen\./);
  assert.match(e.sections.impact, /Funnel/);
  assert.match(e.sections.live_now, /live on your site as of September 21, 2026/);
  assert.equal(e.sections.check?.length, 1);
});

// ── assembly ────────────────────────────────────────────────────────────────

test("sectionsToText fits the MCP detail cap at maximum section sizes", () => {
  const big = (n: number) => "x".repeat(n);
  const text = sectionsToText({ context: big(CAPS.context), changes: big(CAPS.changes), impact: big(CAPS.impact), live_now: big(CAPS.live_now), check: Array(CAPS.checkItems).fill(big(CAPS.check)) });
  assert.ok(text.length <= 4000, `${text.length}`);
  assert.match(text, /^What took place\n/);
  assert.match(text, /\n\nWhat to check\n- /);
});
