import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "friday-relay-test-"));
process.env.AGENTIC_OS_FRIDAY_DATA = TMP;
const ALERTS = path.join(TMP, "autodeploy.alerts");
process.env.AUTODEPLOY_ALERTS_FILE = ALERTS;
delete process.env.FRIDAY_ALERT_WEBHOOK_URL;

type R = typeof import("./ownerAlertRelay");
let R: R;
const sent: string[] = [];
const notify = async (i: { text: string; dedupeKey: string }) => { sent.push(i.text); };
const line = (summary: string) => JSON.stringify({ ts: "2026-10-29T01:00:00Z", from: "autodeploy", summary }) + "\n";

before(async () => { R = await import("./ownerAlertRelay"); });
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("autodeploy alert relay", () => {
  test("no file → nothing", async () => {
    assert.equal(await R.relayAutodeployAlerts({ notify }), "no autodeploy alerts");
  });

  test("new lines are sent once; the offset advances; a partial last line waits", async () => {
    writeFileSync(ALERTS, line("deploy a failed") + line("deploy b failed") + '{"summary":"half');
    await R.relayAutodeployAlerts({ notify, now: 1_000_000 });
    assert.deepEqual(sent, ["Autodeploy: deploy a failed", "Autodeploy: deploy b failed"]);
    sent.length = 0;
    assert.match(await R.relayAutodeployAlerts({ notify, now: 1_000_100 }), /no new|0 sent/);
    appendFileSync(ALERTS, ' line"}\n');
    await R.relayAutodeployAlerts({ notify, now: 1_000_200 });
    assert.deepEqual(sent, ["Autodeploy: half line"]);
  });

  test("the same failure again inside the window is a duplicate (timestamps ignored)", async () => {
    sent.length = 0;
    appendFileSync(ALERTS, line("deploy a failed at 01:02:03"));
    appendFileSync(ALERTS, line("deploy a failed at 04:05:06"));
    await R.relayAutodeployAlerts({ notify, now: 1_000_300 });
    assert.equal(sent.length, 1);
    sent.length = 0;
    appendFileSync(ALERTS, line("deploy a failed at 09:09:09"));
    const r = await R.relayAutodeployAlerts({ notify, now: 1_000_400 });
    assert.equal(sent.length, 0);
    assert.match(r, /1 duplicate/);
  });

  test("rate limit: at most 3 per run, the rest summarised in one line, none lost silently", async () => {
    sent.length = 0;
    for (let i = 0; i < 7; i++) appendFileSync(ALERTS, line(`distinct failure ${i}`));
    const r = await R.relayAutodeployAlerts({ notify, now: 5_000_000 });
    assert.equal(sent.filter((s) => s.startsWith("Autodeploy: distinct")).length, 3);
    assert.equal(sent.filter((s) => /held back/.test(s)).length, 1);
    assert.match(r, /3 sent.*4 held back/);
  });

  test("a truncated/rotated file restarts from the top; malformed lines are skipped", async () => {
    sent.length = 0;
    writeFileSync(ALERTS, "not json\n" + line("fresh after rotate"));
    await R.relayAutodeployAlerts({ notify, now: 9_000_000_000 });
    assert.deepEqual(sent, ["Autodeploy: fresh after rotate"]);
  });
});

describe("localOwnerAlert (needs no OS session)", () => {
  test("writes the log and calls the webhook only when configured", async () => {
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(String(u)); return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;
    const off = await R.localOwnerAlert("t", "body one", { fetch: f, desktop: () => {} });
    assert.equal(off.logged, true);
    assert.equal(off.webhook, false);
    assert.equal(calls.length, 0);
    process.env.FRIDAY_ALERT_WEBHOOK_URL = "https://ntfy.example/topic";
    const on = await R.localOwnerAlert("t", "body two", { fetch: f, desktop: () => {} });
    assert.equal(on.webhook, true);
    assert.deepEqual(calls, ["https://ntfy.example/topic"]);
    assert.ok(existsSync(path.join(TMP, "owner-alerts.log")));
    assert.match(readFileSync(path.join(TMP, "owner-alerts.log"), "utf8"), /body two/);
  });
});
