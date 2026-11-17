import { test } from "node:test";
import assert from "node:assert/strict";
import { RETIRED_CLIENT_CHANNEL_JOBS } from "./scheduler";
import { legacyChannelsOn } from "./legacyChannels";

test("every job that used FRIDAY's own client/owner channels is retired by default", () => {
  for (const id of ["inbox-triage", "gmail-watch-renew", "approval-email-watch", "outbound-flush", "stall-checkin", "feedback-watch", "meeting-watcher", "meeting-prep-watch", "client-docs-drive-sync"]) {
    assert.ok(RETIRED_CLIENT_CHANNEL_JOBS.has(id), id);
  }
});

test("the client-review jobs run on the OS portal now, so they are not retired", () => {
  for (const id of ["client-review-watch", "review-silence-nudge"]) assert.ok(!RETIRED_CLIENT_CHANNEL_JOBS.has(id), id);
});

test("the OS-facing and engineering jobs keep running", () => {
  for (const id of ["os-agent-tasks-poll", "os-agent-requests", "os-approvals-bridge", "portal-updates", "release-approvals", "pr-shepherd", "weekly-client-update", "uptime", "scheduled-agent-tasks"]) {
    assert.ok(!RETIRED_CLIENT_CHANNEL_JOBS.has(id), id);
  }
});

test("the rollback switch is explicit", () => {
  assert.equal(legacyChannelsOn({}), false);
  assert.equal(legacyChannelsOn({ FRIDAY_LEGACY_CHANNELS: "ON" }), true);
  assert.equal(legacyChannelsOn({ FRIDAY_LEGACY_CHANNELS: "1" }), false);
});
