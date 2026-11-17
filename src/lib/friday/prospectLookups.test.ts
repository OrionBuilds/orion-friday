// Deterministic prospect lookups over a FAKE reach-guard: nothing here touches LinkedIn, Exa or
// Jina. Covers input validation, the pre-spend budget mirror, per-lookup call accounting, the
// URL-anchored parsers, and every guard exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linkedinLookup, webRead, linkedinBudget, validateLinkedinInput, validateWebReadInput, redactContacts,
  parseGuardOutput, sectionsText, extractLinkedinCompanies, extractLinkedinPeople, parseCompanyAbout, parsePersonProfile, parseExaResults, nameSimilarity,
  MAX_LINKEDIN_CALLS_PER_LOOKUP, type GuardDeps, type GuardExecResult,
} from "./prospectLookups";

// Tuesday 2026-09-29 11:00 local — inside LinkedIn's Mon–Fri 08–18 window.
const NOW = new Date(2026, 8, 29, 11, 0, 0);
const day = "2026-09-29";

function mcp(dict: unknown): string { return JSON.stringify({ content: [{ type: "text", text: JSON.stringify(dict) }] }); }

const COMPANY_SEARCH = mcp({
  url: "https://www.linkedin.com/search/results/companies/?keywords=Roof%20X",
  sections: { search_results: [
    "Globex Inc\nRoofing · Tampa, FL · 412 followers\nhttps://www.linkedin.com/company/globex-inc/\nTampa's roofing contractor — globex.example",
    "Globexperts LLC\nConstruction · Orlando, FL\nhttps://www.linkedin.com/company/globex-xperts/",
    "Sunshine Roofing\nhttps://www.linkedin.com/company/sunshine-roofing-tampa/",
  ].join("\n\n") },
});
const COMPANY_PROFILE = mcp({
  url: "https://www.linkedin.com/company/globex-inc/",
  sections: { about: "Globex Inc\nOverview\nTampa's roofing contractor since 2008, residential and commercial.\nWebsite\nhttps://globex.example\nIndustry\nConstruction\nCompany size\n11-50 employees\n38 associated members\nHeadquarters\nTampa, FL\nFounded\n2008" },
  references: { about: [{ kind: "company_urn", value: "9988776" }] },
});
const PEOPLE_SEARCH = mcp({
  url: "https://www.linkedin.com/search/results/people/",
  sections: { search_results: [
    "John Smith\nView John Smith's profile\nhttps://www.linkedin.com/in/johnsmithglobex/\nOwner at Globex Inc\nTampa, Florida, United States\n2nd",
    "Maria Lopez\nhttps://www.linkedin.com/in/maria-lopez-globex/\nOffice Manager at Globex Inc\nBrandon, FL",
    "Dan Patel\nhttps://www.linkedin.com/in/dpatel/\nPresident at Globex Inc\nTampa Bay Area",
  ].join("\n\n") },
});
const PERSON_PROFILE = mcp({ url: "https://www.linkedin.com/in/johnsmithglobex/", sections: { profile: "John Smith\nOwner & President at Globex Inc\nTampa, Florida, United States\n500+ connections\nAbout\nThird-generation roofer." } });

interface Fake { calls: string[][]; script: Array<(args: string[]) => GuardExecResult>; }
function deps(over: Partial<GuardDeps> & { state?: Record<string, unknown>; config?: Record<string, unknown>; stop?: boolean } = {}): { d: GuardDeps; fake: Fake } {
  const fake: Fake = { calls: [], script: [] };
  const d: GuardDeps = {
    exec: async (args) => { fake.calls.push(args); const fn = fake.script.shift(); return fn ? fn(args) : { code: 0, stdout: "", stderr: "" }; },
    readGuardConfig: () => over.config ?? {},
    readGuardState: () => over.state ?? {},
    stopExists: () => over.stop ?? false,
    now: () => NOW,
    ...over,
  };
  return { d, fake };
}
const ok = (stdout: string) => () => ({ code: 0, stdout, stderr: "" });
const INPUT = { company: { name: "Globex Inc", domain: "globex.example", city: "Tampa", state: "FL" }, personas: ["Owner", "President"], max_profiles: 2 };

test("validateLinkedinInput: name + personas required; max_profiles clamped 0..3; strings trimmed", () => {
  assert.equal(validateLinkedinInput({ company: { name: " " }, personas: ["Owner"] }).ok, false);
  assert.equal(validateLinkedinInput({ company: { name: "X" }, personas: [] }).ok, false);
  const v = validateLinkedinInput({ company: { name: " Globex ", city: " Tampa " }, personas: ["Owner", "", 3], max_profiles: 9 });
  assert.ok(v.ok);
  assert.deepEqual(v.input.company, { name: "Globex", domain: undefined, city: "Tampa", state: undefined });
  assert.deepEqual(v.input.personas, ["Owner"]);
  assert.equal(v.input.max_profiles, 3);
  assert.equal(validateLinkedinInput({ company: { name: "X" }, personas: ["Owner"] }).ok && (validateLinkedinInput({ company: { name: "X" }, personas: ["Owner"] }) as { input: { max_profiles: number } }).input.max_profiles, 2);
});

test("validateWebReadInput: read needs an http url, search needs a query, num_results clamped", () => {
  assert.equal(validateWebReadInput({ mode: "read", url: "ftp://x" }).ok, false);
  assert.equal(validateWebReadInput({ mode: "search", query: " " }).ok, false);
  assert.equal(validateWebReadInput({ mode: "browse" }).ok, false);
  const s = validateWebReadInput({ mode: "search", query: "roofers Tampa", num_results: 99 });
  assert.ok(s.ok && s.input.num_results === 10);
});

test("linkedinBudget mirrors the guard: counts from today's state, caps from guard.json, closed reasons", () => {
  const base = { readGuardConfig: () => ({ linkedin: { caps: { search: 10, view: 25 } } }), readGuardState: () => ({ linkedin: { counts: { [day]: { search: 7, view: 3 } } } }), stopExists: () => false, now: () => NOW };
  const b = linkedinBudget(base);
  assert.deepEqual(b, { searches_used: 7, views_used: 3, remaining_today: { searches: 3, views: 22 }, open: true });
  assert.equal(linkedinBudget({ ...base, stopExists: () => true }).closed_reason, "kill_switch");
  assert.equal(linkedinBudget({ ...base, readGuardConfig: () => ({ linkedin: { enabled: false } }) }).closed_reason, "disabled");
  assert.equal(linkedinBudget({ ...base, readGuardState: () => ({ linkedin: { locked_until: "2026-12-01T00:00:00" } }) }).closed_reason, "locked");
  assert.equal(linkedinBudget({ ...base, now: () => new Date(2026, 8, 29, 19, 0) }).closed_reason, "outside_hours");
  assert.equal(linkedinBudget({ ...base, now: () => new Date(2026, 8, 26, 11, 0) }).closed_reason, "outside_hours"); // Saturday
  // Yesterday's counts don't count today.
  assert.equal(linkedinBudget({ ...base, readGuardState: () => ({ linkedin: { counts: { "2026-09-28": { search: 10 } } } }) }).remaining_today.searches, 10);
});

test("parsers: mcporter JSON envelope, company/people extraction, about/profile fields, Exa blocks", () => {
  const cs = parseGuardOutput(COMPANY_SEARCH);
  assert.ok(cs.dict && typeof cs.dict.url === "string");
  const companies = extractLinkedinCompanies(sectionsText(cs));
  assert.deepEqual(companies.map((c) => [c.name, c.slug]), [["Globex Inc", "globex-inc"], ["Globexperts LLC", "globex-xperts"], ["Sunshine Roofing", "sunshine-roofing-tampa"]]);
  assert.match(companies[0].snippet ?? "", /globex\.example/);
  const people = extractLinkedinPeople(sectionsText(parseGuardOutput(PEOPLE_SEARCH)));
  assert.equal(people.length, 3);
  assert.deepEqual({ ...people[0] }, { full_name: "John Smith", username: "johnsmithglobex", url: "https://www.linkedin.com/in/johnsmithglobex/", title: "Owner at Globex Inc", location: "Tampa, Florida, United States" });
  assert.equal(people[2].title, "President at Globex Inc");
  assert.deepEqual(parseCompanyAbout(sectionsText(parseGuardOutput(COMPANY_PROFILE))), { headcount: "11-50", founded: "2008", hq: "Tampa, FL", description: "Tampa's roofing contractor since 2008, residential and commercial." });
  assert.deepEqual(parsePersonProfile(sectionsText(parseGuardOutput(PERSON_PROFILE))), { full_name: "John Smith", title: "Owner & President at Globex Inc", location: "Tampa, Florida, United States" });
  assert.equal(parseGuardOutput("plain text, not json").text, "plain text, not json");
  const exa = parseExaResults("Title: Globex Inc – Tampa\nURL: https://globex.example/\nPublished: 2026-01-02\nAuthor: N/A\nHighlights:\nSince 2008.\n...\nFree estimates.\n\nTitle: Yelp\nURL: https://yelp.com/x\nPublished: N/A\nHighlights:\nReviews.");
  assert.deepEqual(exa, [
    { title: "Globex Inc – Tampa", url: "https://globex.example/", snippet: "Since 2008. Free estimates.", published: "2026-01-02" },
    { title: "Yelp", url: "https://yelp.com/x", snippet: "Reviews.", published: undefined },
  ]);
  assert.ok(nameSimilarity("Globex, Inc.", "Globex Inc Florida") > 0.9);
  assert.ok(nameSimilarity("Globex Inc", "Sunshine Roofing") < 0.34);
});

test("linkedinLookup: happy path = company search → people search → 2 profile views; budget and confidence reported", async () => {
  const { d, fake } = deps({ state: { linkedin: { counts: { [day]: { search: 1, view: 2 } } } } });
  fake.script = [ok(COMPANY_SEARCH), ok(PEOPLE_SEARCH), ok(PERSON_PROFILE), ok(mcp({ url: "x", sections: { profile: "Dan Patel\nPresident at Globex Inc\nTampa Bay Area" } }))];
  const r = await linkedinLookup(INPUT, d);
  assert.ok(r.ok && r.kind === "prospect.linkedin_lookup");
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(fake.calls[0].slice(0, 3), ["linkedin", "search_companies", "keywords=Globex Inc Tampa FL"]);
  assert.deepEqual(fake.calls[1].slice(0, 4), ["linkedin", "search_people", "keywords=Globex Inc", "location=Tampa, FL"]);
  assert.deepEqual(fake.calls[2].slice(0, 3), ["linkedin", "get_person_profile", "linkedin_username=johnsmithglobex"]);
  assert.deepEqual(fake.calls[3].slice(0, 3), ["linkedin", "get_person_profile", "linkedin_username=dpatel"]);
  assert.ok(fake.calls.every((c) => c.includes("--output") && c.includes("json")));
  assert.equal(r.company_profile?.linkedin_url, "https://www.linkedin.com/company/globex-inc/");
  assert.equal(r.company_profile?.headcount, undefined); // no company page opened by default
  // Persona matches first, opened profiles at 0.9, the search-only office manager at 0.4.
  assert.deepEqual(r.people.map((p) => [p.full_name, p.matched_persona, p.confidence]), [["John Smith", "Owner", 0.9], ["Dan Patel", "President", 0.9], ["Maria Lopez", undefined, 0.4]]);
  assert.equal(r.people[0].title, "Owner & President at Globex Inc");
  assert.equal(r.people[0].source_url, "https://www.linkedin.com/in/johnsmithglobex/");
  assert.deepEqual(r.budget, { searches_used: 3, views_used: 4, remaining_today: { searches: 7, views: 21 } });
  assert.equal(r.skipped_reason, undefined);
  assert.equal(r.raw_excerpts.length, 4);
  // Never an email or a phone anywhere in the result.
  assert.doesNotMatch(JSON.stringify(r), /@|\+1\d{10}/);
});

test("linkedinLookup: include_company_profile opens the company page once and threads the URN into people search", async () => {
  const { d, fake } = deps();
  fake.script = [ok(COMPANY_SEARCH), ok(COMPANY_PROFILE), ok(PEOPLE_SEARCH), ok(PERSON_PROFILE)];
  const r = await linkedinLookup({ ...INPUT, max_profiles: 1, include_company_profile: true }, d);
  assert.ok(r.ok && r.kind === "prospect.linkedin_lookup");
  assert.deepEqual(fake.calls[1].slice(0, 3), ["linkedin", "get_company_profile", "company_name=globex-inc"]);
  assert.ok(fake.calls[2].includes("current_company=9988776"));
  assert.deepEqual(r.company_profile, { linkedin_url: "https://www.linkedin.com/company/globex-inc/", headcount: "11-50", founded: "2008", hq: "Tampa, FL", description: "Tampa's roofing contractor since 2008, residential and commercial." });
  assert.equal(fake.calls.length, MAX_LINKEDIN_CALLS_PER_LOOKUP);
  assert.equal(r.budget.views_used, 2);
});

test("linkedinLookup: refuses before spending when the budget is gone, closed, or the kill switch is on", async () => {
  for (const [over, reason] of [
    [{ state: { linkedin: { counts: { [day]: { search: 10, view: 0 } } } } }, "linkedin_budget_exhausted"],
    [{ stop: true }, "linkedin_kill_switch"],
    [{ now: () => new Date(2026, 8, 29, 7, 0) }, "linkedin_outside_hours"],
    [{ state: { linkedin: { locked_until: "2099-01-01T00:00:00" } } }, "linkedin_locked"],
  ] as const) {
    const { d, fake } = deps(over as Partial<GuardDeps>);
    const r = await linkedinLookup(INPUT, d);
    assert.ok(r.ok && r.kind === "prospect.linkedin_lookup");
    assert.equal(r.skipped_reason, reason);
    assert.equal(fake.calls.length, 0, reason);
    assert.deepEqual(r.people, []);
  }
});

test("linkedinLookup: a cap refusal mid-way keeps what was found; a lock or a logout is an error the owner must hear about", async () => {
  const refused = deps();
  refused.fake.script = [ok(COMPANY_SEARCH), () => ({ code: 64, stdout: "", stderr: "reach-guard: REFUSED — linkedin daily search cap reached (10/10). Resets at midnight." })];
  const r1 = await linkedinLookup(INPUT, refused.d);
  assert.ok(r1.ok && r1.kind === "prospect.linkedin_lookup");
  assert.match(r1.skipped_reason ?? "", /^linkedin_refused: .*cap reached/);
  assert.equal(r1.company_profile?.linkedin_url, "https://www.linkedin.com/company/globex-inc/");
  assert.equal(r1.budget.searches_used, 2); // the guard counts the refused attempt too

  const locked = deps();
  locked.fake.script = [() => ({ code: 75, stdout: "", stderr: "reach-guard: LOCKED — linkedin pushed back ('captcha'). Locked for 72h." })];
  const r2 = await linkedinLookup(INPUT, locked.d);
  assert.ok(!r2.ok && r2.locked === true);
  assert.match(r2.error, /LOCKED/);

  const out = deps();
  out.fake.script = [() => ({ code: 69, stdout: "", stderr: "reach-guard: linkedin is not logged in." })];
  const r3 = await linkedinLookup(INPUT, out.d);
  assert.ok(!r3.ok && r3.not_logged_in === true);

  // A refused PROFILE view stops opening profiles but keeps the search hits.
  const late = deps();
  late.fake.script = [ok(COMPANY_SEARCH), ok(PEOPLE_SEARCH), () => ({ code: 64, stdout: "", stderr: "REFUSED — linkedin daily view cap reached (25/25)" })];
  const r4 = await linkedinLookup(INPUT, late.d);
  assert.ok(r4.ok && r4.kind === "prospect.linkedin_lookup");
  assert.equal(r4.people.length, 3);
  assert.equal(r4.people[0].confidence, 0.6);
  assert.ok(r4.raw_excerpts.some((e) => e.call === "refused"));
});

test("linkedinLookup: no company match still searches people by name; skips profile views when none are left", async () => {
  const { d, fake } = deps({ state: { linkedin: { counts: { [day]: { search: 0, view: 25 } } } } });
  fake.script = [ok(mcp({ sections: { search_results: "Unrelated Co\nhttps://www.linkedin.com/company/unrelated/" } })), ok(PEOPLE_SEARCH)];
  const r = await linkedinLookup(INPUT, d);
  assert.ok(r.ok && r.kind === "prospect.linkedin_lookup");
  assert.equal(r.company_profile, undefined);
  assert.equal(fake.calls.length, 2);
  assert.equal(r.people[0].confidence, 0.6);
  assert.ok(r.raw_excerpts.some((e) => /no profile views left/.test(e.text)));
});

test("linkedinLookup: emails and phones a page happens to carry are scrubbed from excerpts and people; bad input is flagged invalid_input", async () => {
  const { d, fake } = deps();
  fake.script = [
    ok(COMPANY_SEARCH.replace("globex.example", "globex.example · +1 (813) 555-0100")),
    ok(PEOPLE_SEARCH.replace("John Smith\nView", "John Smith\n+44 20 7946 0958\nowner@example.com\nView")),
  ];
  const r = await linkedinLookup({ ...INPUT, max_profiles: 0 }, d);
  assert.ok(r.ok && r.kind === "prospect.linkedin_lookup");
  const dump = JSON.stringify(r);
  assert.doesNotMatch(dump, /\+44 20 7946 0958|owner@example\.com|813\) 555-0100/);
  assert.match(dump, /\[redacted contact\]/);
  assert.equal(r.people[0].full_name, "John Smith");
  assert.equal(redactContacts("call +1 813-555-0100 or (813) 555-0101 or a@b.co"), "call [redacted contact] or [redacted contact] or [redacted contact]");
  assert.equal(redactContacts("11-50 employees since 2008, 412 followers"), "11-50 employees since 2008, 412 followers");
  const bad = await linkedinLookup({ company: { name: "" }, personas: [] }, d);
  assert.ok(!bad.ok && bad.invalid_input === true);
  const badWeb = await webRead({ mode: "read", url: "nope" }, d);
  assert.ok(!badWeb.ok && badWeb.invalid_input === true);
  // A backend error whose text happens to say "required" is NOT flagged as bad input.
  fake.script = [() => ({ code: 1, stdout: "", stderr: "backend: login required for r.jina.ai" })];
  const backend = await webRead({ mode: "read", url: "https://x.y" }, d);
  assert.ok(!backend.ok && backend.invalid_input === undefined && backend.refused === undefined);
});

test("webRead: read → Jina text capped; search → Exa blocks parsed; guard errors propagate", async () => {
  const { d, fake } = deps();
  fake.script = [ok("Title: Globex\n\nAbout us — since 2008.")];
  const r = await webRead({ mode: "read", url: "https://globex.example/about" }, d);
  assert.ok(r.ok && r.kind === "prospect.web_read" && r.mode === "read");
  assert.deepEqual(fake.calls[0], ["web", "read", "https://globex.example/about"]);
  assert.match(r.text ?? "", /since 2008/);
  assert.equal(r.source, "jina");

  fake.script = [ok(JSON.stringify({ content: [{ type: "text", text: "Title: Globex\nURL: https://globex.example/\nPublished: N/A\nHighlights:\nHi." }] }))];
  const s = await webRead({ mode: "search", query: "Globex Tampa", num_results: 3 }, d);
  assert.ok(s.ok && s.kind === "prospect.web_read" && s.mode === "search");
  assert.deepEqual(fake.calls[1], ["web", "search", "query=Globex Tampa", "numResults=3", "--output", "json"]);
  assert.deepEqual(s.results, [{ title: "Globex", url: "https://globex.example/", snippet: "Hi.", published: undefined }]);

  fake.script = [() => ({ code: 64, stdout: "", stderr: "REFUSED — web daily read cap reached" })];
  const e = await webRead({ mode: "read", url: "https://x.y" }, d);
  assert.ok(!e.ok && e.refused === true);
  assert.equal((await webRead({ mode: "read", url: "nope" }, d)).ok, false);
});
