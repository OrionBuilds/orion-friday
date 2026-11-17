import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorTaskToOs, osTargetFor, normalizeTitle, hasOsMarker, ROUND_TITLE, type MirrorDeps } from "./osMirror";

function fakeDeps(opts: { osId?: string | null; rowId?: string | null } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const deps: MirrorDeps = {
    callTool: async (name, args) => { calls.push({ name, args }); return opts.rowId === null ? [] : [{ id: opts.rowId ?? "row-1" }]; },
    osProjectId: async () => (opts.osId === undefined ? "os-proj-1" : opts.osId),
    updateTask: async (id, patch) => { patches.push({ id, patch }); return null; },
  };
  return { deps, calls, patches };
}

const baseTask = { id: "t1", title: "Add a call-duration column", details: "client asked for duration", description: "", origin: "email" as const };
const project = { id: "local-1", name: "mAI Dashboard" };

test("osTargetFor: bug → ticket, everything else → change request", () => {
  assert.deepEqual(osTargetFor("bug"), { table: "ticket", requestType: "bug_report" });
  assert.deepEqual(osTargetFor("feature"), { table: "cr", requestType: "feature" });
  assert.deepEqual(osTargetFor("change"), { table: "cr", requestType: "scope" });
  assert.deepEqual(osTargetFor("other"), { table: "cr", requestType: "other" });
  assert.deepEqual(osTargetFor(undefined), { table: "cr", requestType: "other" });
});

test("normalizeTitle / ROUND_TITLE / hasOsMarker", () => {
  assert.equal(normalizeTitle("[QA] Coaching tool: Resend + PDFs!"), "coaching tool resend pdfs");
  assert.ok(ROUND_TITLE.test("[Fix R2] thing") && ROUND_TITLE.test("[QA] x") && !ROUND_TITLE.test("[Deps] x"));
  assert.ok(hasOsMarker({ details: "x [os-cr:abc]", description: "" }));
  assert.ok(!hasOsMarker({ details: "x", description: "" }));
});

test("feature ask → in_progress change request + marker stamped into details", async () => {
  const { deps, calls, patches } = fakeDeps();
  const r = await mirrorTaskToOs({ task: { ...baseTask }, project, kind: "feature", clientName: "Taylor", clientEmail: "t@x.com" }, deps);
  assert.deepEqual(r, { ok: true, marker: "[os-cr:row-1]", osId: "row-1", table: "cr" });
  assert.equal(calls[0].name, "project_change_requests_create");
  assert.equal(calls[0].args.status, "in_progress");
  assert.equal(calls[0].args.project_id, "os-proj-1");
  assert.equal(calls[0].args.client_email, "t@x.com");
  assert.match(String(patches[0].patch.details), /\[os-cr:row-1\]$/);
});

test("bug ask → support ticket; email origin is recorded as source=email", async () => {
  const { deps, calls } = fakeDeps({ rowId: "tk-9" });
  const r = await mirrorTaskToOs({ task: { ...baseTask }, project, kind: "bug" }, deps);
  assert.equal(r.ok && r.marker, "[os-ticket:tk-9]");
  assert.equal(calls[0].name, "project_support_tickets_create");
  assert.equal(calls[0].args.source, "email");
  assert.equal(calls[0].args.request_type, "bug_report");
});

test("skips: round tasks, already-linked, portal-born, unmapped project, and never throws", async () => {
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await mirrorTaskToOs({ task: { ...baseTask, title: "[QA] x" }, project, kind: "feature" }, deps), { ok: false, skipped: "round task" });
  assert.deepEqual(await mirrorTaskToOs({ task: { ...baseTask, details: "x [os-ticket:1]" }, project, kind: "bug" }, deps), { ok: false, skipped: "already linked" });
  assert.deepEqual(await mirrorTaskToOs({ task: { ...baseTask, origin: "os_ticket" }, project, kind: "bug" }, deps), { ok: false, skipped: "portal-born" });
  assert.deepEqual(await mirrorTaskToOs({ task: { ...baseTask }, project, kind: "bug" }, fakeDeps({ osId: null }).deps), { ok: false, skipped: "no OS project" });
  assert.equal(calls.length, 0);
  const boom: Partial<MirrorDeps> = { ...fakeDeps().deps, callTool: async () => { throw new Error("os down"); } };
  const r = await mirrorTaskToOs({ task: { ...baseTask }, project, kind: "feature" }, boom);
  assert.equal(r.ok, false);
  assert.match((r as { skipped: string }).skipped, /os down/);
});
