import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPrTask, isQaTask, withLatestQaPass } from "./prShepherd";
import { qaRoundTitle } from "./qaHeal";

type T = { id: string; title: string; assignee: string; createdAt: string; sourceTaskId?: string };
const t = (id: string, title: string, assignee: string, createdAt: string, sourceTaskId?: string): T => ({ id, title, assignee, createdAt, sourceTaskId });

test("isQaTask spots QA rounds by assignee or title", () => {
  assert.ok(isQaTask({ title: "[QA] Orders: edit address", assignee: "qa" }));
  assert.ok(isQaTask({ title: "[QA] [QA] Orders", assignee: "dev" }));
  assert.equal(isQaTask({ title: "Orders: edit address", assignee: "dev" }), false);
});

test("the PR's work task wins over newer QA and fix rounds (no more [QA] [QA] …)", () => {
  const root = t("root", "Orders: edit address/contact", "dev", "2026-09-25T15:00:00Z");
  const qa1 = t("qa1", "[QA] Orders: edit address/contact", "qa", "2026-09-26T09:00:00Z", "root");
  const fix = t("fix", "[Fix R1] issues from QA — Orders", "dev", "2026-09-26T10:00:00Z", "root");
  const qa2 = t("qa2", "[QA] [QA] Orders: edit address/contact", "qa", "2026-09-28T16:29:00Z", "qa1");
  assert.equal(pickPrTask([root, qa1, fix, qa2])?.id, "root");
});

test("without a root, the newest non-QA task; with only QA tasks, the newest one", () => {
  const fix1 = t("fix1", "[Fix R1] X", "dev", "2026-09-26T10:00:00Z", "gone");
  const fix2 = t("fix2", "[Fix R2] X", "dev", "2026-09-27T10:00:00Z", "gone");
  const qa = t("qa", "[QA] X", "qa", "2026-09-28T10:00:00Z", "gone");
  assert.equal(pickPrTask([fix1, qa, fix2])?.id, "fix2");
  assert.equal(pickPrTask([qa])?.id, "qa");
  assert.equal(pickPrTask([]), null);
});

test("a QA title never nests", () => {
  assert.equal(qaRoundTitle("[QA] [QA] [QA] Orders"), "[QA] Orders");
  assert.equal(qaRoundTitle("Orders"), "[QA] Orders");
  assert.equal(qaRoundTitle("x".repeat(200)).length, 120);
});

test("the newest QA pass on any work task counts for the PR, never a QA task's own stamp", () => {
  const root = { title: "Orders", assignee: "dev", qaPassedAt: "2026-09-26T10:00:00Z" };
  const fix = { title: "[Fix R1] Orders", assignee: "dev", qaPassedAt: "2026-09-28T10:00:00Z" };
  const qa = { title: "[QA] Orders", assignee: "qa", qaPassedAt: "2026-09-29T10:00:00Z" };
  assert.equal(withLatestQaPass(root, [root, fix, qa]).qaPassedAt, "2026-09-28T10:00:00Z");
  const bare = { title: "Orders", assignee: "dev" } as { title: string; assignee: string; qaPassedAt?: string };
  assert.equal(withLatestQaPass(bare, [bare, qa]).qaPassedAt, undefined);
  assert.equal(withLatestQaPass(root, [root]), root);
});
