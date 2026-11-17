// Tests for FRIDAY's vault memory: thread files (Where it stands rewritten, History append-only),
// project memory roll-up, recall scoping and size bounds, lineage roots, and message→project matching.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  setMemoryRootForTests, recordOutcome, recallFor, threadPrs, projectMemoryBlock, rootTaskOf,
  stripRoundPrefix, threadSlug, localStamp, applyOutcome, parseThread, renderThread,
  parseProjectMemory, renderProjectMemory, applyProjectEvent, projectsMentioned,
} from "./vaultMemory";

let dir = "";
before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "friday-mem-")); setMemoryRootForTests(dir); });
after(async () => { setMemoryRootForTests(null); await rm(dir, { recursive: true, force: true }); });

const project = { id: "p1", name: "Mai Dash" };
const root = { id: "abcdef1234567890", title: "Add lead markers to the map" };
const at = (h: number) => new Date(Date.UTC(2026, 8, 25, h, 5));

test("stripRoundPrefix removes stacked round prefixes", () => {
  assert.equal(stripRoundPrefix("[QA] [Fix R2] issues from QA — Add markers"), "Add markers");
  assert.equal(stripRoundPrefix("[Review R1] review comments — Map fixes"), "Map fixes");
  assert.equal(stripRoundPrefix("Plain title"), "Plain title");
});

test("threadSlug is the root title plus the first 8 of its id", () => {
  assert.equal(threadSlug(root), "add-lead-markers-to-the-map-abcdef12");
  assert.equal(threadSlug({ id: root.id, title: "[QA] " + root.title }), "add-lead-markers-to-the-map-abcdef12");
});

test("localStamp uses Eastern time, not UTC", () => {
  // 02:30 UTC on Sep 26 is 22:30 on Sep 25 in New York (EDT).
  assert.deepEqual(localStamp(new Date("2026-09-26T02:30:00Z")), { date: "2026-09-25", time: "22:30" });
});

test("rootTaskOf walks sourceTaskId to the lineage root", async () => {
  const tasks: Record<string, { id: string; title: string; sourceTaskId?: string }> = {
    a: { id: "a", title: "Root" }, b: { id: "b", title: "[QA] Root", sourceTaskId: "a" }, c: { id: "c", title: "[Fix R1] Root", sourceTaskId: "b" },
  };
  const got = await rootTaskOf(tasks.c, async (id) => tasks[id] ?? null);
  assert.equal(got.id, "a");
  // A missing parent stops at the last known task instead of throwing.
  const orphan = await rootTaskOf({ id: "z", title: "Z", sourceTaskId: "gone" }, async () => null);
  assert.equal(orphan.id, "z");
});

test("applyOutcome rewrites Where it stands and appends History; render/parse round-trips", () => {
  const init = { thread: threadSlug(root), project: project.name, client: "Mai", rootTask: root };
  let doc = applyOutcome(null, init, { project, task: root, kind: "build", title: root.title, outcome: "done", summary: "Built markers", prUrl: "https://github.com/o/r/pull/90", at: at(14) });
  doc = applyOutcome(parseThread(renderThread(doc)), init, { project, task: root, kind: "qa-verdict", title: "[QA] " + root.title, outcome: "failed", summary: "Markers overlap", findings: "Z-index bug", at: at(15) });
  const md = renderThread(doc);
  assert.equal(doc.history.length, 2);
  assert.match(md, /### 2026-09-25 10:05 — build: Add lead markers/);
  assert.match(md, /### 2026-09-25 11:05 — qa-verdict:/);
  assert.match(md, /Findings: Z-index bug/);
  assert.deepEqual(doc.meta.prs, ["https://github.com/o/r/pull/90"]);
  assert.equal(doc.meta.status, "failed — needs attention");
  const whereCount = md.split("## Where it stands").length - 1;
  assert.equal(whereCount, 1);
  assert.match(doc.whereItStands, /never open a second PR/);
});

test("project memory keeps one line per thread and the last N events", () => {
  let pm = parseProjectMemory("");
  for (let i = 0; i < 35; i++) pm = applyProjectEvent(pm, "t-1", `line ${i}`, `event ${i}`);
  const back = parseProjectMemory(renderProjectMemory("Mai Dash", pm));
  assert.equal(back.events.length, 30);
  assert.equal(back.events[29], "event 34");
  assert.deepEqual(back.threads, { "t-1": "line 34" });
});

test("recordOutcome writes the thread file and project memory; recall reads them back", async () => {
  await recordOutcome({ project, task: root, kind: "build", title: root.title, outcome: "done", summary: "Opened PR with markers", prUrl: "https://github.com/o/r/pull/90", next: "QA it", at: at(14) });
  await recordOutcome({ project, task: root, kind: "qa-verdict", title: "[QA] " + root.title, outcome: "failed", summary: "Markers overlap on zoom", at: at(15) });
  const file = path.join(dir, "Projects", "mai-dash", "work", `${threadSlug(root)}.md`);
  const md = await readFile(file, "utf8");
  assert.match(md, /^---\nthread: /);
  assert.match(md, /root_task: abcdef1234567890/);
  assert.equal((md.match(/^### 2026-09-25/gm) ?? []).length, 2);
  const pm = await readFile(path.join(dir, "Projects", "mai-dash", "memory.md"), "utf8");
  assert.match(pm, /qa-verdict \(failed\)/);
  // No stray tmp files from the atomic write.
  assert.deepEqual((await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp")), []);

  const recall = await recallFor({ project, task: root });
  assert.match(recall, /This piece of work: Add lead markers to the map/);
  assert.match(recall, /Markers overlap on zoom/);
  assert.deepEqual(await threadPrs(project, root), ["https://github.com/o/r/pull/90"]);
  assert.match(await projectMemoryBlock(project), /where it stands \(from memory\)/);
});

test("recallFor pulls a sibling thread that shares the PR, and respects maxChars", async () => {
  const sibling = { id: "9999999900000000", title: "Map follow-up" };
  await recordOutcome({ project, task: sibling, kind: "review-round", title: sibling.title, outcome: "done", summary: "Answered CodeRabbit", prUrl: "https://github.com/o/r/pull/90", at: at(16) });
  const recall = await recallFor({ project, task: root, prUrl: "https://github.com/o/r/pull/90" });
  assert.match(recall, /Related work on the same pull request: Map follow-up/);
  const small = await recallFor({ project, task: root, maxChars: 300 });
  assert.ok(small.length <= 300, `got ${small.length}`);
  assert.match(small, /truncated/);
});

test("memory calls are safe no-ops without a project", async () => {
  assert.deepEqual(await recordOutcome({ project: null, kind: "build", title: "x", outcome: "done", summary: "" }), { ok: false });
  assert.equal(await recallFor({ project: null }), "");
});

test("projectsMentioned matches whole project names or an explicit id", () => {
  const ps = [{ id: "1", name: "Mai Dash" }, { id: "2", name: "AI Coach Tool" }, { id: "3", name: "X" }];
  assert.deepEqual(projectsMentioned("where are we on the mai dash map?", ps).map((p) => p.id), ["1"]);
  assert.deepEqual(projectsMentioned("anything new", ps, "2").map((p) => p.id), ["2"]);
  assert.deepEqual(projectsMentioned("x marks the spot", ps), []); // names under 3 chars never match
  assert.deepEqual(projectsMentioned("maidashboard", ps), []);
});
