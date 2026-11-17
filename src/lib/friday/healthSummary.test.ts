import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { engineStates, overallHealthy } from "./healthSummary";

const deep = {
  claude: { configured: true, authed: true },
  codex: { configured: true, authed: true },
  antigravity: { configured: true, authed: null },
  lmstudio: { configured: false, authed: null },
  hermes: { configured: false, authed: null },
};

describe("health summary", () => {
  test("hermes is not listed; lmstudio is informational while not expected", () => {
    const e = engineStates(deep, {});
    assert.equal("hermes" in e, false);
    assert.equal(e.lmstudio, "not_expected");
    assert.equal(e.antigravity, "degraded");
    assert.equal(overallHealthy({ db: true, osAuthBroken: false, engines: e, env: {} }), true);
  });
  test("once LM Studio is expected, down degrades the status; ok does not", () => {
    const env = { FRIDAY_LMSTUDIO_EXPECTED: "1" };
    const e = engineStates(deep, env);
    assert.equal(e.lmstudio, "down");
    assert.equal(overallHealthy({ db: true, osAuthBroken: false, engines: e, env }), false);
    const up = engineStates({ ...deep, lmstudio: { configured: true, authed: true } }, env);
    assert.equal(overallHealthy({ db: true, osAuthBroken: false, engines: up, env }), true);
  });
  test("db error or a broken OS session still fail", () => {
    const e = engineStates(deep, {});
    assert.equal(overallHealthy({ db: false, osAuthBroken: false, engines: e, env: {} }), false);
    assert.equal(overallHealthy({ db: true, osAuthBroken: true, engines: e, env: {} }), false);
  });
});
