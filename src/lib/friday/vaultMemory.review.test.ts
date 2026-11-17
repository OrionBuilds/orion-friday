// Tests for the PR #32 review fixes: thread status precedence, client-safe memory projection,
// client note profile preservation, notification/merge outcomes, health from memory blockers, and
// refusing a run whose existing PR branch can't be read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextThreadStatus, clientSafeStatus, clientSafeProjectMemory, parseProjectMemory } from "./vaultMemory";
import { renderClientProfile, clientStatusSection, CLIENT_STATUS_START, CLIENT_STATUS_END, withFileLock, writeFileAtomic } from "@/lib/persistence/obsidian";
import { notifyOutcome } from "./clientNotify";
import { shepherdRecordsOutcome } from "./prShepherd";
import { deriveHealth, memoryBlockers } from "./statusReport";
import { taskPrStillOpen } from "./orchestrator";
import type { Client } from "@/lib/friday/types";

test("thread status: info keeps state, done/waiting never downgrade merged/live, failures always set", () => {
  assert.equal(nextThreadStatus("live", "info"), "live");
  assert.equal(nextThreadStatus(undefined, "info"), "in progress");
  assert.equal(nextThreadStatus("merged", "done"), "merged");
  assert.equal(nextThreadStatus("live", "waiting"), "live");
  assert.equal(nextThreadStatus("in progress", "waiting"), "waiting");
  assert.equal(nextThreadStatus("live", "failed"), "failed — needs attention");
  assert.equal(nextThreadStatus("merged", "deployed"), "live");
});

test("client-safe memory: coarse status words only, no costs, links or failure details", () => {
  assert.equal(clientSafeStatus("failed — needs attention"), "in progress");
  assert.equal(clientSafeStatus("stuck — handed to the owner"), "in progress");
  assert.equal(clientSafeStatus("merged"), "finished, going live");
  assert.equal(clientSafeStatus("live"), "live");
  const pm = parseProjectMemory([
    "## Where it stands",
    "- [[work/add-lead-markers-abcdef12]] — failed — needs attention · QA failed, $4.10 spent https://github.com/x/y/pull/9 (2026-09-25 10:00)",
    "- [[work/fix-login-12345678]] — live · deployed (2026-09-24 09:00)",
    "",
  ].join("\n"));
  const out = clientSafeProjectMemory("Mai Dash", pm);
  assert.match(out, /1 piece of work in progress/);
  assert.match(out, /1 piece of work live/);
  // Thread names come from internal task titles and never reach a client.
  assert.doesNotMatch(out, /\$|https?:|QA failed|abcdef12|lead markers|fix login/);
});

test("client note: profile fields render and the status section survives a profile rewrite", () => {
  const client = { id: "c1", name: "Jo Roe", company: "Roe Co", email: "jo@roe.co", phone: "555", status: "active", tags: ["vip"], notes: "Prefers SMS.", updatedAt: "2026-09-25" } as unknown as Client;
  const profile = renderClientProfile(client);
  for (const s of ["**Company:** Roe Co", "**Email:** jo@roe.co", "**Phone:** 555", "**Tags:** vip", "Prefers SMS."]) assert.ok(profile.includes(s), s);
  const existing = profile + `\n${CLIENT_STATUS_START}\n## Where things stand\n- Mai Dash: in progress\n${CLIENT_STATUS_END}\n\n*Updated 2026-09-20*\n`;
  const section = clientStatusSection(existing);
  assert.match(section, /## Where things stand\n- Mai Dash: in progress/);
  assert.doesNotMatch(section, /Updated 2026-09-20/);
  assert.equal(clientStatusSection(profile), "");
  // A "Where things stand" heading inside the client's own notes is never captured (no duplication).
  const withNotesHeading = renderClientProfile({ ...client, notes: "## Where things stand\nOur own note." } as Client);
  assert.equal(clientStatusSection(withNotesHeading), "");
  assert.equal(clientStatusSection(withNotesHeading + section).match(/Our own note/g), null);
});

test("a queued notification is waiting, not sent; a failure is failed", () => {
  assert.equal(notifyOutcome(true), "info");
  assert.equal(notifyOutcome(true, true), "waiting");
  assert.equal(notifyOutcome(false, true), "failed");
  assert.equal(notifyOutcome(false), "failed");
});

test("a successful merge leaves the deploy outcome as the thread status", () => {
  assert.equal(shepherdRecordsOutcome("merge", true), false);
  assert.equal(shepherdRecordsOutcome("merge", false), true);
  assert.equal(shepherdRecordsOutcome("rebase", true), true);
});

test("health goes red on a failed/blocked/stuck memory thread and agrees with the blocked list", () => {
  const base = { tasks: [], runs: [], approvals: [], deploys: [], now: new Date("2026-09-25T12:00:00Z") };
  assert.equal(deriveHealth(base), "green");
  const memory = [{ thread: "add-lead-markers", line: "failed — needs attention · QA failed (2026-09-25 10:00)" }, { thread: "fix-login", line: "live · deployed" }];
  assert.equal(memoryBlockers(memory).length, 1);
  assert.equal(deriveHealth({ ...base, memory }), "red");
  assert.equal(deriveHealth({ ...base, memory: [memory[1]] }), "green");
});

test("an existing PR with an unreadable branch counts as open (refuse), a merged/closed one does not", async () => {
  assert.equal(await taskPrStillOpen("u", async () => null), true);
  assert.equal(await taskPrStillOpen("u", async () => { throw new Error("gh down"); }), true);
  assert.equal(await taskPrStillOpen("u", async () => ({ state: "OPEN" })), true);
  assert.equal(await taskPrStillOpen("u", async () => ({ state: "MERGED" })), false);
  assert.equal(await taskPrStillOpen("u", async () => ({ state: "CLOSED" })), false);
});

test("vault note writes to the same path are serialized by one shared lock", async () => {
  const order: string[] = [];
  const slow = withFileLock("/tmp/x/_client.md", async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 20)); order.push("a-end"); });
  const fast = withFileLock("/tmp/x/../x/_client.md", async () => { order.push("b"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("atomic note write: owner-only for new notes, keeps an existing mode, leaves no temp file on failure", async () => {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const pth = await import("node:path");
  const dir = await fsp.mkdtemp(pth.join(os.tmpdir(), "vm-atomic-"));
  try {
    const f = pth.join(dir, "n.md");
    await writeFileAtomic(f, "one");
    assert.equal((await fsp.stat(f)).mode & 0o777, 0o600);
    await fsp.chmod(f, 0o640);
    await writeFileAtomic(f, "two");
    assert.equal(await fsp.readFile(f, "utf8"), "two");
    assert.equal((await fsp.stat(f)).mode & 0o777, 0o640);
    // Renaming onto a directory fails: the temp file must not be left behind.
    const d = pth.join(dir, "adir");
    await fsp.mkdir(pth.join(d, "child"), { recursive: true });
    await assert.rejects(writeFileAtomic(d, "x"));
    assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
