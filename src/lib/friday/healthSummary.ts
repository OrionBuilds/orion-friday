// /api/health decision logic (pure, so it can be tested).
//
// 2026-10-29: retired components no longer count. The inbound-email loop (inbox-triage) and Hermes
// are retired, so a stale email loop must not turn the endpoint "degraded"/503, and Hermes is not
// listed at all. Engines are informational only. LM Studio is coming back, so its probe stays, but
// while it is not expected it is reported as "not_expected" and cannot affect the overall status;
// set FRIDAY_LMSTUDIO_EXPECTED=1 once it is back and a down LM Studio will then degrade the status.

export type EngineState = "ok" | "degraded" | "down" | "not_expected";
export interface EngineProbe { configured: boolean; authed: boolean | null }

/** Engines that were retired and must not appear in /api/health at all. */
export const RETIRED_ENGINES: ReadonlySet<string> = new Set(["hermes"]);

export function engineStates(
  deep: Record<string, EngineProbe>,
  env: Record<string, string | undefined> = process.env,
): Record<string, EngineState> {
  const lmExpected = env.FRIDAY_LMSTUDIO_EXPECTED === "1";
  const out: Record<string, EngineState> = {};
  for (const [name, h] of Object.entries(deep)) {
    if (RETIRED_ENGINES.has(name)) continue;
    const raw: EngineState = !h.configured ? "down" : h.authed === false ? "down" : h.authed === true ? "ok" : "degraded";
    out[name] = name === "lmstudio" && !lmExpected && raw !== "ok" ? "not_expected" : raw;
  }
  return out;
}

export function overallHealthy(input: {
  db: boolean;
  osAuthBroken: boolean;
  engines: Record<string, EngineState>;
  env?: Record<string, string | undefined>;
}): boolean {
  const lmExpected = (input.env ?? process.env).FRIDAY_LMSTUDIO_EXPECTED === "1";
  const lmDown = lmExpected && input.engines["lmstudio"] === "down";
  return input.db && !input.osAuthBroken && !lmDown;
}
