// The agents' own repos: any PR merges once green, conflict-free and CodeRabbit-clean on its head
// (upkeep-only under FRIDAY_INTERNAL_MERGE=upkeep); no agent rounds are ever dispatched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { internalRepos, internalFixRounds, internalSupabaseRef, githubOwners, shepherdScope, extraRepos, isInternalRepo, isInternalUpkeep, majorBumps, decideInternal, type InternalDecideInput } from "./internalRepos";
import type { PrReadiness } from "./prGate";
import type { ReviewFeedback } from "./prReview";
import { freshState } from "./prShepherd";
import { AGENCY } from "./persona";

// Pin the owner so these fixtures (written under the legacy acme-dev owner) are deterministic and
// independent of the checkout's git remote; owner normalisation has its own tests below.
process.env.GITHUB_OWNER = "acme-dev";
process.env.FRIDAY_GITHUB_LEGACY_OWNERS = "acme-dev";
delete process.env.FRIDAY_GITHUB_OWNERS;
delete process.env.FRIDAY_INTERNAL_REPOS;

const NOW = Date.parse("2026-09-25T21:00:00Z");
const pr = (over: Partial<PrReadiness> = {}): PrReadiness => ({
  url: "https://github.com/acme-dev/friday/pull/28", number: 28, owner: "acme-dev", repo: "friday", state: "OPEN", isDraft: false,
  title: "deps: weekly patch bumps (2026-09-25)", author: "acme-dev", headRefName: "deps/weekly-2026-09-25", baseRefName: "master",
  headSha: "abc1234", mergeable: "MERGEABLE", mergeState: "CLEAN", checks: "SUCCESS", coderabbitCheck: "pass", failingChecks: [], pendingChecks: [],
  createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T10:00:00Z", ...over,
});
const review = (over: Partial<ReviewFeedback> = {}): ReviewFeedback => ({ fetchOk: true, headSha: "abc1234", actionable: [], skipped: [], summaries: [], humanChangesRequested: false, botReviewPending: false, botReviewedShas: [], coderabbitReviewedHead: true, coderabbitPresent: true, ...over });
const input = (over: Partial<InternalDecideInput> = {}): InternalDecideInput => ({
  pr: pr(), review: review(), files: ["package.json", "package-lock.json"], majors: [], siblings: [], state: freshState(), mode: "active", policy: "reviewed", now: NOW, ...over,
});

test("the internal repo list defaults to the five agent repos and can be overridden or disabled", () => {
  assert.equal(internalRepos(undefined).length, 5);
  assert.ok(isInternalRepo("acme-dev/ORION-FRIDAY", internalRepos(undefined)));
  assert.deepEqual(internalRepos("acme/one, acme/two"), ["acme/one", "acme/two"]);
  assert.deepEqual(internalRepos("off"), []);
});

test("upkeep = a dependency sweep or lockfile/package.json/CI-only files; logic changes are not", () => {
  assert.equal(isInternalUpkeep({ headRefName: "deps/weekly-2026-09-25", title: "deps: weekly patch bumps" }, ["src/x.ts"]), true);
  assert.equal(isInternalUpkeep({ headRefName: "friday/ci", title: "ci tweak" }, [".github/workflows/ci.yml", "package-lock.json"]), true);
  assert.equal(isInternalUpkeep({ headRefName: "friday/feature", title: "new feature" }, ["src/lib/friday/x.ts", "package.json"]), false);
  assert.equal(isInternalUpkeep({ headRefName: "friday/feature", title: "new feature" }, []), false);
});

test("majorBumps catches major and 0.x-minor changes, ignores patch/minor", () => {
  const patch = [
    '-    "next": "16.3.5",', '+    "next": "16.3.6",',
    '-    "typescript": "^5.9.2",', '+    "typescript": "^6.0.3",',
    '-    "zod": "0.3.1",', '+    "zod": "0.4.0",',
    '-    "react": "^19.1.0",', '+    "react": "^19.2.0",',
  ].join("\n");
  assert.deepEqual(majorBumps(patch), ["typescript ^5.9.2 → ^6.0.3", "zod 0.3.1 → 0.4.0"]);
});

test("green upkeep merges; everything else is skipped, waited on, or reported once", () => {
  assert.deepEqual(decideInternal(input()), { kind: "merge" });
  assert.deepEqual(decideInternal(input({ files: ["src/app/page.tsx"], pr: pr({ title: "feat: x", headRefName: "friday/x" }), policy: "upkeep" })), { kind: "skip", reason: "internal-non-upkeep" });
  assert.equal(decideInternal(input({ majors: ["typescript ^5 → ^6"] })).kind, "give-up");
  assert.equal(decideInternal(input({ pr: pr({ checks: "FAILURE", failingChecks: ["ci"] }) })).kind, "give-up");
  assert.deepEqual(decideInternal(input({ pr: pr({ checks: "PENDING" }), state: { ...freshState(), lastPushSeenAt: "2026-09-25T20:50:00Z" } })), { kind: "wait", reason: "checks-pending" });
  assert.equal(decideInternal(input({ pr: pr({ checks: "NONE" }) })).kind, "give-up");
  assert.equal(decideInternal(input({ review: review({ humanChangesRequested: true }) })).kind, "give-up");
  assert.deepEqual(decideInternal(input({ review: review({ actionable: [{} as never] }) })), { kind: "review-round", count: 1 });
  assert.deepEqual(decideInternal(input({ pr: pr({ isDraft: true }) })), { kind: "skip", reason: "draft" });
  assert.deepEqual(decideInternal(input({ mode: "off" })), { kind: "skip", reason: "off" });
});

test("older sweeps are superseded; conflicts try a branch update once, then report; old conflicts close", () => {
  assert.deepEqual(decideInternal(input({ pr: pr({ number: 21 }), siblings: [pr({ number: 21 }), pr({ number: 28 })] })), { kind: "close-superseded", by: 28 });
  assert.deepEqual(decideInternal(input({ pr: pr({ mergeable: "CONFLICTING" }) })), { kind: "rebase", via: "update-branch" });
  assert.equal(decideInternal(input({ pr: pr({ mergeable: "CONFLICTING" }), state: { ...freshState(), lastAction: "rebase:update-branch" } })).kind, "give-up");
  assert.deepEqual(decideInternal(input({ pr: pr({ mergeable: "CONFLICTING", createdAt: "2026-09-01T00:00:00Z" }) })), { kind: "close-stale" });
});

test("fails closed: no merge when the review fetch failed, even on an old green upkeep PR", () => {
  const old = { pr: pr({ createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T10:00:00Z" }), state: { ...freshState(), lastPushSeenAt: "2026-09-20T10:00:00Z" } };
  const r = decideInternal(input({ ...old, review: review({ fetchOk: false, botReviewPending: true }) }));
  assert.deepEqual(r, { kind: "wait", reason: "fetch-failed" });
});

test("fails closed: no merge when the changed-file list is unknown or incomplete", () => {
  assert.deepEqual(decideInternal(input({ filesOk: false, files: [], majors: [] })), { kind: "wait", reason: "fetch-failed" });
  assert.equal(decideInternal(input({ filesOk: true })).kind, "merge");
});

test("a package.json record without a patch parses as unreadable (null), never as an empty diff", async () => {
  const { parsePagedFiles } = await import("./prShepherd");
  const rows = parsePagedFiles('{"f":"package.json","p":null}\n{"f":"package-lock.json","p":"@@ -1 +1 @@"}\n');
  assert.equal(rows[0].p, null);
  assert.equal(rows[1].p, "@@ -1 +1 @@");
});

test("internal repos: no merge without CodeRabbit coverage of the head; findings (incl. outside-diff) give up", () => {
  const at = (ago: number, extra: Partial<InternalDecideInput> = {}) => decideInternal(input({
    pr: pr({ coderabbitCheck: "pending" }), review: review({ coderabbitReviewedHead: false }),
    state: { ...freshState(), lastPushSeenAt: new Date(NOW - ago).toISOString() }, ...extra,
  }));
  assert.deepEqual(at(5 * 60_000), { kind: "wait", reason: "review-pending" });
  assert.deepEqual(at(16 * 60_000), { kind: "request-review" });
  assert.equal(at(50 * 60_000, { state: { ...freshState(), lastPushSeenAt: new Date(NOW - 50 * 60_000).toISOString(), botReviewRequestedForSha: "abc1234" } }).kind, "wait");
  const g = at(3 * 60 * 60_000);
  assert.equal(g.kind, "give-up");
  assert.match((g as { why: string }).why, /won't merge unreviewed code/);
  const ni = decideInternal(input({ pr: pr({ coderabbitCheck: "absent" }), review: review({ coderabbitReviewedHead: false, coderabbitPresent: false }), repoHasCodeRabbit: false }));
  assert.match((ni as { why: string }).why, /CodeRabbit isn't installed on acme-dev\/friday/);
  const body = decideInternal(input({ review: review({ actionable: [{ id: "cr:x", key: "cr:x", source: "review-body", author: "coderabbitai", bot: "coderabbit", body: "b", severity: "major", isResolved: false, isOutdated: false }] }) }));
  assert.deepEqual(body, { kind: "review-round", count: 1 }, "review-body findings get a fix round too");
  assert.equal(decideInternal(input()).kind, "merge");
});

test("code PRs on agent repos merge once CodeRabbit passes, on the same gates; never closed as stale", () => {
  const code = (over: Partial<InternalDecideInput> = {}) => input({ files: ["src/lib/clara/places.ts"], pr: pr({ title: "fix: places", headRefName: "fix/places" }), ...over });
  assert.deepEqual(decideInternal(code()), { kind: "merge" });
  assert.deepEqual(decideInternal(code({ review: review({ actionable: [{} as never] }) })), { kind: "review-round", count: 1 });
  assert.equal(decideInternal(code({ review: review({ humanChangesRequested: true }) })).kind, "give-up");
  assert.equal(decideInternal(code({ pr: pr({ title: "fix: places", headRefName: "fix/places", checks: "FAILURE", failingChecks: ["ci"] }) })).kind, "give-up");
  assert.deepEqual(
    decideInternal(code({ pr: pr({ title: "fix: places", headRefName: "fix/places", coderabbitCheck: "pending" }), review: review({ coderabbitReviewedHead: false }), state: { ...freshState(), lastPushSeenAt: new Date(NOW - 60_000).toISOString() } })),
    { kind: "wait", reason: "review-pending" },
  );
  const old = { title: "fix: places", headRefName: "fix/places", mergeable: "CONFLICTING" as const, createdAt: "2026-09-01T00:00:00Z" };
  assert.deepEqual(decideInternal(code({ pr: pr(old) })), { kind: "rebase", via: "update-branch" });
  // update-branch couldn't merge the base: a bounded conflict-resolution round, then a report.
  assert.deepEqual(decideInternal(code({ pr: pr(old), state: { ...freshState(), lastAction: "rebase:update-branch" } })), { kind: "rebase", via: "round" });
  const g = decideInternal(code({ pr: pr(old), state: { ...freshState(), lastAction: "rebase:update-branch", rebaseRounds: 2 } }));
  assert.equal(g.kind, "give-up");
  assert.doesNotMatch((g as { why: string }).why, /weekly sweep/);
  assert.equal(decideInternal(code({ pr: pr(old), fixRounds: 0, state: { ...freshState(), lastAction: "rebase:update-branch" } })).kind, "give-up");
});

test("merge policy defaults to reviewed; FRIDAY_INTERNAL_MERGE=upkeep restores upkeep-only", async () => {
  const { internalMergePolicy } = await import("./internalRepos");
  assert.equal(internalMergePolicy(undefined), "reviewed");
  assert.equal(internalMergePolicy(""), "reviewed");
  assert.equal(internalMergePolicy("UPKEEP"), "upkeep");
});

test("scope 'all': every repo with an open PR is shepherded, minus client projects and the agents' own repos", () => {
  assert.equal(shepherdScope(undefined), "all");
  assert.equal(shepherdScope("listed"), "listed");
  assert.deepEqual(githubOwners(undefined), ["acme-dev"], "defaults to GITHUB_OWNER, no hardcoded owners");
  assert.deepEqual(githubOwners("acme, other"), ["acme", "other"]);
  const discovered = ["acme-dev/orion", "acme-dev/orion", "acme-dev/Client-App", "acme-dev/friday", "acme-dev/client-site", "bad repo"];
  assert.deepEqual(extraRepos(discovered, ["acme-dev/client-app"], ["acme-dev/friday"]), ["acme-dev/client-site", "acme-dev/orion"]);
});

test("fix rounds on internal repos: capped (default 3, FRIDAY_INTERNAL_FIX_ROUNDS), 0 restores give-up", () => {
  assert.equal(internalFixRounds(undefined), 3);
  assert.equal(internalFixRounds("5"), 5);
  assert.equal(internalFixRounds("0"), 0);
  assert.equal(internalFixRounds("nope"), 3);
  assert.equal(internalFixRounds("0oops"), 3, "a numeric prefix is a typo, not 'disable'");
  assert.equal(internalFixRounds(" 2 "), 2);
  assert.equal(internalFixRounds("-1"), 3);
  assert.equal(internalFixRounds("9".repeat(400)), 3, "Infinity would never hit the cap");
  assert.equal(internalFixRounds("9007199254740993"), 3, "unsafe integers fall back too");
  const f = review({ actionable: [{} as never, {} as never] });
  assert.deepEqual(decideInternal(input({ review: f, state: { ...freshState(), reviewRounds: 2 } })), { kind: "review-round", count: 2 });
  const capped = decideInternal(input({ review: f, state: { ...freshState(), reviewRounds: 3 } }));
  assert.equal(capped.kind, "give-up");
  assert.match((capped as { why: string }).why, /2 review comments still open after 3 fix rounds/);
  const off = decideInternal(input({ review: f, fixRounds: 0 }));
  assert.equal(off.kind, "give-up");
  assert.match((off as { why: string }).why, /fix rounds on these repos are turned off/);
});

test("a running round is waited on; a finished one is resolved before feedback is re-read", () => {
  const round = { kind: "review" as const, taskId: "t1", startedSha: "abc1234", threads: [] };
  assert.deepEqual(decideInternal(input({ roundRunning: true, state: { ...freshState(), round } })), { kind: "wait", reason: "round-running" });
  assert.deepEqual(decideInternal(input({ state: { ...freshState(), round: { ...round, startedSha: "0ld5ha0" } } })), { kind: "resolve-round" });
  // Same head and no running round: nothing new was pushed, normal gates apply (no infinite resolve).
  assert.equal(decideInternal(input({ state: { ...freshState(), round } })).kind, "merge");
});

test("internalRepoProject: reuses an attached project, else creates a paused one under the internal client", async () => {
  const { internalRepoProject } = await import("./prShepherd");
  const made: Record<string, unknown>[] = [];
  const base = {
    findClients: async () => [{ id: "c-int", name: `Internal (${AGENCY})`, company: AGENCY }],
    createClient: async () => { throw new Error("should reuse the internal client"); },
    createProject: async (i: { clientId: string; name: string; repoUrls: string[] }) => { made.push(i); return { id: "p-new", ...i, status: "active", createdAt: "", updatedAt: "" } as never; },
    updateProject: async (id: string, patch: Record<string, unknown>) => ({ id, ...made[0], ...patch, createdAt: "", updatedAt: "" }) as never,
  };
  const existing = { id: "p-old", clientId: "c1", name: "FRIDAY", status: "active", repoUrls: ["https://github.com/acme-dev/friday.git"], createdAt: "", updatedAt: "" };
  const reused = await internalRepoProject("acme-dev/FRIDAY", { ...base, findProjects: async (pred) => [existing as never].filter(pred) });
  assert.equal(reused.id, "p-old");
  assert.equal(made.length, 0);
  const created = await internalRepoProject("acme-dev/orion", { ...base, findProjects: async (pred) => [existing as never].filter(pred) });
  assert.equal(created.status, "paused", "paused so the client sweep never claims it");
  assert.equal(created.portalUpdates, false);
  assert.deepEqual(made[0], { clientId: "c-int", name: "acme-dev/orion (GitHub)", repoUrls: ["https://github.com/acme-dev/orion.git"], description: (made[0] as { description: string }).description });
});

test("conflict round that ended without pushing goes straight to the next bounded round (no update-branch retry)", () => {
  const conflicted = pr({ title: "fix: x", headRefName: "fix/x", mergeable: "CONFLICTING" });
  const code = { files: ["src/a.ts"], pr: conflicted };
  const round = { kind: "rebase" as const, taskId: "t1", startedSha: conflicted.headSha, threads: [] };
  assert.deepEqual(decideInternal(input({ ...code, state: { ...freshState(), lastAction: "rebase:round", round, rebaseRounds: 1 } })), { kind: "rebase", via: "round" });
  assert.equal(decideInternal(input({ ...code, state: { ...freshState(), lastAction: "rebase:round", round, rebaseRounds: 2 } })).kind, "give-up");
  // A rebase round on an OLDER head isn't evidence for this head: resolve that round first.
  assert.deepEqual(decideInternal(input({ ...code, state: { ...freshState(), lastAction: "rebase:round", round: { ...round, startedSha: "0ld5ha0" } } })), { kind: "resolve-round" });
});

test("internalSupabaseRef: the OS repo maps to the OS project; FRIDAY_SUPABASE_REFS adds/overrides; others null", () => {
  const REF = "abcdefghijklmnopqrsu";
  assert.equal(internalSupabaseRef("acme-dev/Orion", undefined, REF), REF);
  assert.equal(internalSupabaseRef("acme-dev/Orion", undefined, null), null, "no ref configured ⇒ none (never a hardcoded ref)");
  assert.equal(internalSupabaseRef("acme-dev/client-os", undefined, REF), null);
  assert.equal(internalSupabaseRef("acme-dev/client-os", "acme-dev/client-os=abcdefghijklmnopqrst, junk"), "abcdefghijklmnopqrst");
});

test("internalRepoProject: SSH and trailing-slash remotes reuse the attached project; FRIDAY's own repo keeps the self-edit gate", async () => {
  const { internalRepoProject } = await import("./prShepherd");
  const made: unknown[] = [];
  const base = {
    findClients: async () => [{ id: "c-int", name: `Internal (${AGENCY})`, company: AGENCY }],
    createClient: async () => { throw new Error("unused"); },
    createProject: async (i: { clientId: string; name: string; repoUrls: string[] }) => { made.push(i); return { id: "p-new", ...i, status: "active", createdAt: "", updatedAt: "" } as never; },
    updateProject: async (id: string, patch: Record<string, unknown>) => ({ id, ...(made[0] as object), ...patch, createdAt: "", updatedAt: "" }) as never,
    selfRepoKey: () => "acme-dev/friday",
    selfDir: "/srv/FRIDAY",
  };
  const ssh = { id: "p-ssh", clientId: "c1", name: "FRIDAY", status: "active", repoUrls: ["git@github.com:acme-dev/friday.git"], createdAt: "", updatedAt: "" };
  const slash = { id: "p-slash", clientId: "c1", name: "OS", status: "paused", repoUrls: ["https://github.com/acme-dev/orion.git/"], createdAt: "", updatedAt: "" };
  const all = [ssh, slash] as never[];
  const self = await internalRepoProject("acme-dev/friday", { ...base, findProjects: async (pred) => all.filter(pred) });
  assert.equal(self.id, "p-ssh");
  assert.equal(self.workspaceDir, "/srv/FRIDAY", "her own repo runs under the self-edit gate");
  const os = await internalRepoProject("acme-dev/orion", { ...base, findProjects: async (pred) => all.filter(pred) });
  assert.equal(os.id, "p-slash");
  assert.equal(os.workspaceDir, undefined);
  assert.equal(made.length, 0, "no duplicate placeholder projects");
  // No attached project for her own repo: the placeholder still carries the gate.
  const fresh = await internalRepoProject("acme-dev/friday", { ...base, findProjects: async () => [] });
  assert.equal(fresh.workspaceDir, "/srv/FRIDAY");
  assert.equal(fresh.status, "paused");
});

test("maybePushMigrations (internal merge): pushes merged migrations to the given ref; nothing to push → silent; no ref → tells the owner", async () => {
  const { maybePushMigrations } = await import("./prShepherd");
  const texts: Array<{ kind: string; text: string }> = [];
  const pushes: Array<{ projectRef: string; mergeSha: string }> = [];
  const deps = (files: string[]) => ({
    listChangedFiles: async () => files,
    supabaseRefForProject: async () => { throw new Error("no project lookup for internal repos"); },
    accessToken: () => "sbp_test",
    push: (async (i: { projectRef: string; mergeSha: string }) => { pushes.push(i); return { ok: true, summary: "1 applied" }; }) as never,
    textOwner: async (t: { kind: string; text: string }) => { texts.push(t); },
  });
  const merged = pr({ owner: "acme-dev", repo: "orion", number: 45, url: "https://github.com/acme-dev/orion/pull/45" });
  await maybePushMigrations(null, merged, "deadbeef", { projectRef: "qrstuvwxyzabcdefghij", label: "acme-dev/orion", deps: deps(["supabase/migrations/20261009230000_example.sql", "src/x.ts"]) });
  assert.deepEqual(pushes.map((p) => [p.projectRef, p.mergeSha]), [["qrstuvwxyzabcdefghij", "deadbeef"]]);
  assert.equal(texts[0].kind, "migrations_pushed");
  assert.match(texts[0].text, /^acme-dev\/orion: 1 migration\(s\) deployed/);
  await maybePushMigrations(null, merged, "deadbeef", { projectRef: "qrstuvwxyzabcdefghij", deps: deps(["src/x.ts"]) });
  assert.equal(pushes.length, 1, "no migrations in the merge → no push, no text");
  assert.equal(texts.length, 1);
  await maybePushMigrations(null, merged, "deadbeef", { projectRef: null, label: "acme-dev/orion", deps: deps(["supabase/migrations/1_x.sql"]) });
  assert.equal(texts[1].kind, "migrations_push_failed");
  assert.match(texts[1].text, /FRIDAY_SUPABASE_REFS/);
});

test("maybePushMigrations: a failed changed-files lookup is reported, never read as 'no migrations'", async () => {
  const { maybePushMigrations } = await import("./prShepherd");
  const texts: Array<{ kind: string; text: string }> = [];
  let pushed = 0;
  await maybePushMigrations(null, pr({ url: "https://github.com/acme-dev/orion/pull/46" }), "cafebabe", {
    projectRef: "qrstuvwxyzabcdefghij", label: "acme-dev/orion",
    deps: {
      listChangedFiles: async () => { throw new Error("GitHub 502"); },
      accessToken: () => "sbp_test",
      push: (async () => { pushed++; return { ok: true, summary: "" }; }) as never,
      textOwner: async (t: { kind: string; text: string }) => { texts.push(t); },
    },
  });
  assert.equal(pushed, 0);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].kind, "migrations_push_failed");
  assert.match(texts[0].text, /couldn't list its changed files \(Error: GitHub 502\)/);
});

test("internalRepoProject: a placeholder whose pause didn't persist is a provisioning failure, not a paused-in-memory project", async () => {
  const { internalRepoProject } = await import("./prShepherd");
  await assert.rejects(internalRepoProject("acme-dev/agency-site", {
    findProjects: async () => [],
    findClients: async () => [{ id: "c-int", name: `Internal (${AGENCY})`, company: AGENCY }] as never,
    createClient: async () => { throw new Error("unused"); },
    createProject: async (i) => ({ id: "p-new", ...i, status: "active", createdAt: "", updatedAt: "" }) as never,
    updateProject: async () => null,
    selfRepoKey: () => "acme-dev/friday",
  }), /couldn't pause the placeholder project for acme-dev\/agency-site/);
});

test("internalRepoProject: a leftover placeholder that never got paused is paused before reuse (or fails)", async () => {
  const { internalRepoProject } = await import("./prShepherd");
  const leftover = { id: "p-left", clientId: "c-int", name: "acme-dev/agency-site (GitHub)", description: "Created by FRIDAY's PR shepherd so review-fix rounds on this repo have a home. Internal rules apply; no client portal updates.", status: "active", repoUrls: ["https://github.com/acme-dev/agency-site.git"], createdAt: "", updatedAt: "" };
  const patches: Array<Record<string, unknown>> = [];
  const deps = (ok: boolean) => ({
    findProjects: async (pred: (p: never) => boolean) => [leftover as never].filter(pred),
    findClients: async () => [] as never,
    createClient: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("must reuse, not create"); },
    updateProject: async (id: string, patch: Record<string, unknown>) => { patches.push(patch); return ok ? ({ ...leftover, ...patch, id }) as never : null; },
    selfRepoKey: () => "acme-dev/friday",
  });
  const fixed = await internalRepoProject("acme-dev/agency-site", deps(true));
  assert.equal(fixed.status, "paused");
  assert.equal(fixed.portalUpdates, false);
  assert.deepEqual(patches[0], { status: "paused", portalUpdates: false });
  await assert.rejects(internalRepoProject("acme-dev/agency-site", deps(false)), /couldn't pause the placeholder project/);
  // A real (non-placeholder) attached project is reused as-is, never reconfigured.
  patches.length = 0;
  const real = { ...leftover, id: "p-real", name: "Agency Site", description: "client site" };
  const reused = await internalRepoProject("acme-dev/agency-site", { ...deps(true), findProjects: async (pred: (p: never) => boolean) => [real as never].filter(pred) });
  assert.equal(reused.id, "p-real");
  assert.equal(patches.length, 0);
});

test("GitHub owner is config: GITHUB_OWNER drives defaults; legacy owner keys normalise to it", async () => {
  const { githubOwner, normalizeGithubUrl, normalizeRepoKey, legacyGithubOwners } = await import("./githubOwner");
  const { osSupabaseRef, defaultInternalRepos } = await import("./internalRepos");
  assert.equal(githubOwner("acme-labs"), "acme-labs");
  assert.deepEqual(legacyGithubOwners(undefined), ["acme-dev"]);
  assert.deepEqual(legacyGithubOwners(""), [], "no hardcoded legacy owners");
  assert.deepEqual(legacyGithubOwners("old1, Old2"), ["old1", "old2"]);
  assert.equal(normalizeGithubUrl("https://github.com/acme-dev/client-web.git", "acme-labs", ["acme-dev"]), "https://github.com/acme-labs/client-web.git");
  assert.equal(normalizeGithubUrl("git@github.com:ACME-DEV/x.git", "acme-labs", ["acme-dev"]), "git@github.com:acme-labs/x.git");
  assert.equal(normalizeGithubUrl("https://github.com/someclient/x", "acme-labs", ["acme-dev"]), "https://github.com/someclient/x", "non-legacy owners untouched");
  assert.equal(normalizeGithubUrl("https://gitlab.com/acme-dev/x", "acme-labs", ["acme-dev"]), "https://gitlab.com/acme-dev/x");
  assert.equal(normalizeRepoKey("acme-dev/orion", "acme-labs", ["acme-dev"]), "acme-labs/orion");
  assert.deepEqual(internalRepos(undefined, "acme-labs"), ["acme-labs/orion", "acme-labs/orion-agent-core", "acme-labs/orion-clara", "acme-labs/orion-friday", "acme-labs/orion-harvey"]);
  assert.deepEqual(internalRepos("acme-dev/friday", "acme-labs"), ["acme-labs/friday"]);
  assert.deepEqual(defaultInternalRepos(null), [], "no owner known ⇒ no guessed repos");
  assert.deepEqual(githubOwners(undefined, "acme-labs"), ["acme-labs"]);
  assert.deepEqual(githubOwners("acme-dev, acme-labs, acme", "acme-labs"), ["acme-labs", "acme"], "a legacy owner in the list is never searched");
  assert.deepEqual(githubOwners(undefined, null), []);
  assert.equal(osSupabaseRef({ ORION_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }), "abcdefghijklmnopqrst");
  assert.equal(osSupabaseRef({ ORION_SUPABASE_REF: "zyxwvutsrqponmlkjihg" }), "zyxwvutsrqponmlkjihg");
  assert.equal(osSupabaseRef({}), null);
  assert.equal(internalSupabaseRef("acme-dev/orion", undefined, "abcdefghijklmnopqrst", "acme-labs"), "abcdefghijklmnopqrst", "legacy key still finds the OS repo");
});

test("projectRepos: local list (kept in step with the OS by connectionsSync); legacy owners normalised; deduped", async () => {
  const { projectRepos, localProjectRepos } = await import("./types");
  const saved = process.env.GITHUB_OWNER;
  process.env.GITHUB_OWNER = "acme-labs";
  try {
    const p = { repoUrls: ["https://github.com/acme-dev/client-web.git", "https://github.com/acme-labs/client-web", "https://github.com/client/other"] };
    assert.deepEqual(projectRepos(p), ["https://github.com/acme-labs/client-web.git", "https://github.com/client/other"], "legacy owner normalised, duplicate dropped");
    assert.deepEqual(projectRepos({ repoUrl: "https://github.com/acme-dev/x" }), ["https://github.com/acme-labs/x"]);
    assert.deepEqual(localProjectRepos(p), p.repoUrls, "local edits see the raw stored list");
  } finally {
    process.env.GITHUB_OWNER = saved;
  }
});

test("projectUrls: joins project_agent_meta (local→OS id) with projects.repo_urls/netlify_site_url", async () => {
  const { joinProjectUrls } = await import("./projectUrls");
  const m = joinProjectUrls(
    [{ local_project_id: "l1", project_id: "o1" }, { local_project_id: "l2", project_id: "o2" }, { local_project_id: null, project_id: "o3" }],
    [{ id: "o1", repo_urls: ["https://github.com/acme-labs/a", ""], netlify_site_url: "https://a.com", staging_url: "" }, { id: "o2" }],
  );
  assert.deepEqual(m.get("l1"), { osProjectId: "o1", repoUrls: ["https://github.com/acme-labs/a"], siteUrl: "https://a.com", stagingUrl: null });
  assert.deepEqual(m.get("l2"), { osProjectId: "o2", repoUrls: [], siteUrl: null, stagingUrl: null });
  assert.equal(m.size, 2);
});


test("connectionsSync pushes the normalised owner: a local acme-dev repo reaches the OS as acme-labs", async () => {
  const { localToOs } = await import("./connectionsSync");
  const saved = process.env.GITHUB_OWNER;
  process.env.GITHUB_OWNER = "acme-labs";
  try {
    const out = localToOs({ repoUrls: ["https://github.com/acme-dev/client-web.git", "https://github.com/acme-labs/client-web"], deployUrl: "client-example.com" } as never);
    assert.deepEqual(out.repo_urls, ["https://github.com/acme-labs/client-web"]);
    assert.equal(out.netlify_site_url, "https://client-example.com");
  } finally {
    process.env.GITHUB_OWNER = saved;
  }
});

test("an internal PR whose mergeability is being recomputed long after its push waits; it gives up only after 45 minutes of waiting", () => {
  const pushedLongAgo = new Date(NOW - 3 * 60 * 60_000).toISOString();
  const recomputing = pr({ mergeable: "UNKNOWN" });
  assert.deepEqual(
    decideInternal(input({ pr: recomputing, state: { ...freshState(), lastPushSeenAt: pushedLongAgo, pendingSince: new Date(NOW - 60_000).toISOString() } })),
    { kind: "wait", reason: "checks-pending" },
  );
  assert.equal(decideInternal(input({ pr: recomputing, state: { ...freshState(), lastPushSeenAt: pushedLongAgo, pendingSince: new Date(NOW - 50 * 60_000).toISOString() } })).kind, "give-up");
});
