// driveDeliverables — the pure decisions behind "every report is a Google Drive document":
// which artifacts upload as what, how files are named, which run results become a Doc, and where
// each role's output is filed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForRun, driveFileName, driveTargetFor, wantsNarrativeDoc } from "./driveDeliverables";

test("artifacts map to Drive targets by extension/mime", () => {
  assert.deepEqual(driveTargetFor({ kind: "pdf", path: "/x/report.pdf" }), { target: "pdf", sourceMime: "application/pdf" });
  assert.deepEqual(driveTargetFor({ kind: "summary", path: "/x/change-summary.md", mime: "text/markdown" }), { target: "doc", sourceMime: "text/html" });
  assert.deepEqual(driveTargetFor({ kind: "file", path: "/x/leads.csv" }), { target: "sheet", sourceMime: "text/csv" });
  assert.equal(driveTargetFor({ kind: "file", path: "/x/photo.png" }), null);
  assert.equal(driveTargetFor({ kind: "pr" }), null);
});

test("file names carry the day, the task and the label", () => {
  const at = new Date("2026-09-24T15:00:00Z");
  assert.equal(driveFileName("Fix the contact form on mobile", "QA Report", at), "2026-09-24 Fix the contact form on mobile — QA Report");
  assert.equal(driveFileName("x".repeat(80), "Run report", at).length <= 11 + 60 + 3 + 10, true);
  assert.equal(driveFileName("Same", "Same", at), "2026-09-24 Same");
});

test("a narrative Doc is created only when nothing else carries the story", () => {
  const long = "word ".repeat(120);
  assert.equal(wantsNarrativeDoc({ result: long, hasNarrative: true, taskTitle: "Build it" }), false);
  assert.equal(wantsNarrativeDoc({ result: "short", hasNarrative: false, taskTitle: "Build it" }), false);
  assert.equal(wantsNarrativeDoc({ result: "Checked the three pages and confirmed the form submits.", hasNarrative: false, taskTitle: "PM check" }), true);
  assert.equal(wantsNarrativeDoc({ result: long, hasNarrative: false, taskTitle: "Build it" }), true);
  assert.equal(wantsNarrativeDoc({ result: long, hasNarrative: false, taskTitle: "[QA] [Fix R2] issues from QA — Build it" }), false);
  assert.equal(wantsNarrativeDoc({ result: long, hasNarrative: false, taskTitle: "[Fix R3] failing checks — Build it", finalRound: true }), true);
});

test("roles file into the right library category", () => {
  assert.equal(categoryForRun("dev"), "Change Summaries");
  assert.equal(categoryForRun("devops"), "Change Summaries");
  assert.equal(categoryForRun("qa"), "QA Reports");
  assert.equal(categoryForRun("seo"), "SEO Audits");
  assert.equal(categoryForRun("debug"), "Bug Reports");
  assert.equal(categoryForRun("researcher"), "Run Reports");
});
