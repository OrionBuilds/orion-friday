import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonArray, isAutoAdoptable, type SkillCandidate } from "./skillsDiscovery";

test("parseJsonArray: clean array, fenced, prose-wrapped, garbage", () => {
  assert.deepEqual(parseJsonArray('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonArray('```json\n[{"a":1},{"b":2}]\n```'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonArray('Here you go: [1,2,3] done'), [1, 2, 3]);
  assert.deepEqual(parseJsonArray("not json"), []);
  assert.deepEqual(parseJsonArray('{"notAnArray":true}'), []);
});

const cand = (o: Partial<SkillCandidate>): SkillCandidate => ({ name: "x", source: "o/r", slug: "x", ...o });

test("isAutoAdoptable: Official or audited-pass AND relevant", () => {
  assert.equal(isAutoAdoptable(cand({ official: true, relevance: 5 })), true, "official + relevant");
  assert.equal(isAutoAdoptable(cand({ audited: true, relevance: 4 })), true, "audited + relevant");
  assert.equal(isAutoAdoptable(cand({ auditStatus: "pass", relevance: 4 })), true, "audit pass + relevant");
});

test("isAutoAdoptable: rejects unsafe or low-relevance", () => {
  assert.equal(isAutoAdoptable(cand({ official: false, audited: false, relevance: 5 })), false, "relevant but neither official nor audited → gate");
  assert.equal(isAutoAdoptable(cand({ official: true, relevance: 2 })), false, "official but low relevance");
  assert.equal(isAutoAdoptable(cand({ auditStatus: "warn", relevance: 5 })), false, "audit warn is not pass");
  assert.equal(isAutoAdoptable(cand({ relevance: 5 })), false, "no safety signal");
});
