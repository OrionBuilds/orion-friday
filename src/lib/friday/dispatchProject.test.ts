import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDispatchProject } from "./dispatchProject";

const projects = [
  { id: "p-old", name: "Legacy Site", status: "active" },
  { id: "p-coach", name: "AI Coach Tool", status: "active" },
  { id: "p-done", name: "Initech Box", status: "completed" },
];

test("a named project wins over the conversation's project", () => {
  assert.equal(resolveDispatchProject(projects, "initech", "p-coach")?.id, "p-done");
  assert.equal(resolveDispatchProject(projects, "p-old", "p-coach")?.id, "p-old");
});

test("no project named: the conversation's project, not the first active one", () => {
  assert.equal(resolveDispatchProject(projects, "", "p-coach")?.id, "p-coach");
});

test("no project named and no conversation project: first active, as before", () => {
  assert.equal(resolveDispatchProject(projects, "")?.id, "p-old");
  assert.equal(resolveDispatchProject(projects, "", "p-missing")?.id, "p-old");
});

test("a name that matches nothing creates nothing", () => {
  assert.equal(resolveDispatchProject(projects, "nope", "p-coach"), undefined);
});
