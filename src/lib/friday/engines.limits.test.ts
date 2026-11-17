import { test } from "node:test";
import assert from "node:assert/strict";
import { codexEventError, isUsageLimitError, osCliArgs, usageLimitAlert } from "./engines";

const CREDITS = "Your workspace is out of credits. Add credits to continue.";

test("codexEventError reads both failure event shapes from `codex exec --json`", () => {
  assert.equal(codexEventError({ type: "error", message: CREDITS }), CREDITS);
  assert.equal(codexEventError({ type: "turn.failed", error: { message: CREDITS } }), CREDITS);
  assert.equal(codexEventError({ type: "turn.started" }), null);
  assert.equal(codexEventError({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), null);
  assert.equal(codexEventError({ type: "error" }), null);
});

test("an out-of-credits Codex failure counts as a usage limit (so FRIDAY fails over)", () => {
  // Streamed path, after the fix: the event text is carried in the error.
  assert.ok(isUsageLimitError(new Error(`codex CLI failed (code 1): ${CREDITS}`)));
  // Buffered path: stderr tail.
  assert.ok(isUsageLimitError(new Error(`codex CLI failed (code 1): user\nsay ok\n\nERROR: ${CREDITS}`)));
  assert.ok(isUsageLimitError("usage_limit_exceeded"));
  assert.ok(isUsageLimitError("insufficient_quota"));
  // The old generic text must not be mistaken for a limit.
  assert.equal(isUsageLimitError(new Error("codex CLI failed (code 1): stream produced no message")), false);
  assert.equal(isUsageLimitError(new Error("TypeError: cannot read properties of undefined")), false);
  // 429 counts only as an HTTP status.
  assert.ok(isUsageLimitError("HTTP 429"));
  assert.ok(isUsageLimitError("request failed with status code: 429"));
  assert.ok(isUsageLimitError("429 Too Many Requests"));
  assert.equal(isUsageLimitError(new Error("codex CLI failed (code 1): wrote 429 lines to src/app/page.tsx")), false);
});

test("Codex credits alert is a plain timely email about money, deduped per day", () => {
  const now = new Date("2026-09-29T15:00:00Z");
  const a = usageLimitAlert("codex", new Error(CREDITS), now);
  assert.equal(a.emergency, false);
  assert.match(a.text, /out of credits/);
  assert.match(a.text, /switching .* to Claude/);
  assert.equal(a.dedupeKey, "usagelimit:codex:credits:2026-09-29");
  assert.equal(usageLimitAlert("codex", new Error(CREDITS), new Date("2026-09-29T23:00:00Z")).dedupeKey, a.dedupeKey);
});

test("Codex rate limit (not credits) and Claude cap keep their own wording", () => {
  const now = new Date("2026-09-29T15:00:00Z");
  const r = usageLimitAlert("codex", new Error("429 too many requests"), now);
  assert.equal(r.emergency, false);
  assert.match(r.headline, /usage limit/);
  const c = usageLimitAlert("claude", new Error("usage limit reached|1790700000"), now);
  assert.equal(c.emergency, true);
  assert.match(c.text, /Claude usage limit hit, resets/);
  assert.match(c.text, /switching to Codex/);
});

test("OS runs pass --allowedTools in the attached form, so the prompt that follows is never swallowed", () => {
  // The spaced form is variadic: `--allowedTools <list> <prompt>` made the CLI treat the prompt as a tool
  // name and exit with "Input must be provided…", so the Claude failover for OS work never ran.
  for (const o of [{ osReadOnly: true }, { write: true }, {}]) {
    const a = osCliArgs(o);
    assert.ok(!a.includes("--allowedTools"), "no variadic spaced form");
    const allowed = a.find((x) => x.startsWith("--allowedTools="));
    assert.ok(allowed && allowed.length > "--allowedTools=".length);
    assert.ok(!/\s/.test(allowed!), "one argv entry, no spaces");
  }
});
