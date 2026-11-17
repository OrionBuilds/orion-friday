// Tests for the skill packer: skills share the prompt budget fairly, a cut skill points at its file, skills
// that can't fit are listed (never silently dropped), argv engines can't push a prompt past MAX_ARG_LEN,
// and truncation never splits a surrogate pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ARG_LEN } from "@autom8ionlab/agent-core";
import { packSkills, skillBudgetFor, truncateSafe } from "./skillBudget";

const sk = (name: string, len: number) => ({
  name,
  body: "x".repeat(len),
  description: `${name} desc`,
  path: `/lib/${name}/SKILL.md`,
});
const bodyLen = (out: string, name: string) => (out.match(new RegExp(`## Skill: ${name}\\n(x*)`)) ?? ["", ""])[1].length;

test("a short skill stays whole; the long one gets the leftover room and a pointer to its file", () => {
  const out = packSkills([sk("a", 1000), sk("b", 20000)], { total: 12000, perSkill: 9000 });
  assert.ok(out.length <= 12000, `length ${out.length}`);
  assert.equal(bodyLen(out, "a"), 1000);
  assert.equal(bodyLen(out, "b"), 9000);
  assert.match(out, /truncated — full skill: \/lib\/b\/SKILL\.md/);
  assert.doesNotMatch(out, /truncated — full skill: \/lib\/a\//);
});

test("equal skills share the budget fairly instead of the first one eating it", () => {
  const out = packSkills([sk("a", 10000), sk("b", 10000), sk("c", 10000)], { total: 15000, perSkill: 9000 });
  const lens = ["a", "b", "c"].map((n) => bodyLen(out, n));
  assert.ok(Math.min(...lens) > 4000, lens.join());
  assert.ok(Math.max(...lens) - Math.min(...lens) <= 1, lens.join());
  assert.ok(out.length <= 15000, `length ${out.length}`);
});

test("the per-skill cap applies even when there's room to spare", () => {
  const out = packSkills([sk("a", 20000)], { total: 40000, perSkill: 9000 });
  assert.equal(bodyLen(out, "a"), 9000);
});

test("skills that can't get a useful slice are listed, not dropped, and the output stays in budget", () => {
  const many = Array.from({ length: 30 }, (_, i) => sk(`s${i}`, 5000));
  const out = packSkills(many, { total: 6000, perSkill: 9000 });
  assert.ok(out.length <= 6000, `length ${out.length}`);
  assert.ok(bodyLen(out, "s0") > 0, "first (pinned) skill is inlined");
  assert.match(out, /Also available/);
  assert.match(out, /- s29 — s29 desc \(\/lib\/s29\/SKILL\.md\)/);
});

test("argv engines never let the prompt pass MAX_ARG_LEN; codex (stdin) isn't argv-capped", () => {
  assert.equal(skillBudgetFor("claude", 1000), 24000);
  assert.equal(skillBudgetFor("claude", 26000), MAX_ARG_LEN - 26000 - 4000);
  assert.equal(skillBudgetFor("antigravity", MAX_ARG_LEN), 0);
  assert.equal(skillBudgetFor("codex", 100000), 40000);
});

test("truncation never splits a surrogate pair", () => {
  const s = "a".repeat(9) + "😀" + "b";
  assert.equal(truncateSafe(s, 10), "a".repeat(9));
  assert.equal(truncateSafe(s, 11), "a".repeat(9) + "😀");
});

test("no skills or no budget yields nothing", () => {
  assert.equal(packSkills([], { total: 1000, perSkill: 900 }), "");
  assert.equal(packSkills([sk("a", 100)], { total: 0, perSkill: 900 }), "");
});
