// FRIDAY usage guardrail — a soft daily cap on agent runs so the autopilot (auto-QA) + scheduler
// can't spawn unbounded work. Counts runs started today; manual/owner dispatches always proceed,
// but AUTO paths (maybeAutoQA, scheduled dispatch) check withinRunBudget() first.

import { promises as fs } from "node:fs";
import path from "node:path";
import { store, FRIDAY_DATA_DIR, logEvent } from "@/lib/persistence/store";
import {
  cachedAgentSettings, getAgentSettings, settingsFor, refusalFor, agentKeyFor, narrowCap, osOnlyCap,
} from "@/lib/friday/agentSettings";

export function dailyRunCap(): number {
  const n = Number(process.env.AGENTIC_OS_DAILY_RUN_CAP);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

export async function runsToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  return (await store.runs.find((r) => (r.startedAt || "").slice(0, 10) === today)).length;
}

// True while today's run count is under the cap IN FORCE (standing cap + any same-day grant).
// Gate AUTO-dispatch paths on this.
export async function withinRunBudget(): Promise<boolean> {
  return (await runsToday()) < (await effectiveDailyRunCap());
}

// ── Spend breaker (2.2) — money dimension on top of the run-count cap ─────────
// The OS (Settings → AI Agents → limits) can NARROW these, never raise them: daily_budget_usd lowers
// DAY_MAX_COST_USD, max_calls_per_day adds a daily model-call ceiling (none exists in code). Read from
// the cached snapshot (sync); null/unset → the env/built-in value, exactly as before.
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const rootLimits = () => settingsFor(cachedAgentSettings())?.limits;
export const dayMaxCostUsd = () => narrowCap(num(process.env.DAY_MAX_COST_USD, 40), rootLimits()?.daily_budget_usd);
export const taskMaxCostUsd = () => num(process.env.TASK_MAX_COST_USD, 5);
export const taskMaxModelCalls = () => num(process.env.TASK_MAX_MODEL_CALLS, 25);
/** OS max_calls_per_day for FRIDAY, or null (no daily model-call ceiling). */
export const dailyModelCallCap = (): number | null => osOnlyCap(rootLimits()?.max_calls_per_day);

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Total known model-call cost recorded today (best-effort — untracked-cost calls contribute 0). */
export async function spendToday(): Promise<number> {
  const today = todayISO();
  const calls = await store.modelCalls.find((c) => (c.ts || "").slice(0, 10) === today);
  return calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
}

/** Model calls recorded today — all of FRIDAY's, or one role's (`agentRole` matches id or role). */
export async function modelCallsToday(roles?: string[]): Promise<{ calls: number; costUsd: number }> {
  const today = todayISO();
  const rows = await store.modelCalls.find((c) =>
    (c.ts || "").slice(0, 10) === today && (!roles || (!!c.agentRole && roles.includes(c.agentRole))));
  return { calls: rows.length, costUsd: rows.reduce((s, c) => s + (c.costUsd ?? 0), 0) };
}

/**
 * OS settings gate for one specialist run (executeRun / dispatchTask). Null = may run. Refuses when
 * FRIDAY or this specialist is paused/disabled, or the specialist's OWN daily budget / call cap
 * (OS row `friday.<agent id>`) is spent. FRIDAY-wide caps keep their existing enforcement points
 * (auto paths only — manual dispatch has always proceeded past the daily caps).
 */
export async function settingsRunRefusal(agent: { id: string; role?: string }): Promise<string | null> {
  const snap = await getAgentSettings({ maxWaitMs: 3_000 });
  const refusal = refusalFor(snap, agent.id);
  if (refusal) return refusal;
  const entry = snap?.subagents[agentKeyFor(agent.id)];
  if (!entry) return null;
  const budget = entry.limits.daily_budget_usd;
  const hasBudget = budget !== null && Number.isFinite(budget) && budget >= 0;
  const callCap = osOnlyCap(entry.limits.max_calls_per_day);
  if (!hasBudget && callCap === null) return null;
  const used = await modelCallsToday([agent.id, ...(agent.role && agent.role !== agent.id ? [agent.role] : [])]);
  const name = entry.display_name ?? agent.id;
  if (callCap !== null && used.calls >= callCap) return `${name} has used its ${callCap} model calls for today (OS agent settings).`;
  if (hasBudget && used.costUsd >= budget!) {
    return `${name} has spent its $${budget!.toFixed(2)} daily budget ($${used.costUsd.toFixed(2)} today, OS agent settings).`;
  }
  return null;
}

// ── Same-day cap increase ────────────────────────────────────────────────────
// A hard daily cap is right until the day a client deadline is real and the work is legitimately
// expensive. Then a breaker that can only say "no" stops being a safety feature and starts being
// the reason something shipped late. So FRIDAY can ASK for more, the owner grants it by text, and the
// grant applies to TODAY only.
//
// Today-only is the whole design. A permanent raise is a decision about the business; a raise to
// clear one deadline is a decision about one day, and it should expire on its own rather than
// quietly becoming the new normal because nobody remembered to put it back. Changing the standing
// budget stays a deliberate edit to DAY_MAX_COST_USD.

/**
 * One dated grant covering BOTH of today's ceilings.
 *
 * Deliberately a single record rather than two parallel files: they share an expiry, they are
 * granted for the same reason ("this deadline needs more today"), and splitting them would mean
 * two mechanisms to reason about and two places for a stale grant to hide.
 */
interface DailyOverride {
  /** YYYY-MM-DD. A grant for any other date is ignored — that IS the expiry. */
  date: string;
  extraUsd?: number;
  extraRuns?: number;
  grantedBy: string;
  grantedAt: string;
  reason?: string;
}

const OVERRIDE_FILE = path.join(FRIDAY_DATA_DIR, "daily-override.json");

async function readOverride(): Promise<DailyOverride | null> {
  try {
    const o = JSON.parse(await fs.readFile(OVERRIDE_FILE, "utf8")) as DailyOverride;
    return o?.date === new Date().toISOString().slice(0, 10) ? o : null;
  } catch {
    return null;
  }
}

/** Write today's grant, merging with whatever is already granted today. */
async function writeOverride(patch: Partial<DailyOverride>, grantedBy: string, reason?: string): Promise<DailyOverride> {
  const current = await readOverride();
  const next: DailyOverride = {
    date: new Date().toISOString().slice(0, 10),
    extraUsd: patch.extraUsd ?? current?.extraUsd,
    extraRuns: patch.extraRuns ?? current?.extraRuns,
    grantedBy, grantedAt: new Date().toISOString(), reason,
  };
  await fs.mkdir(FRIDAY_DATA_DIR, { recursive: true }).catch(() => {});
  const tmp = `${OVERRIDE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, OVERRIDE_FILE);
  return next;
}

/** Today's granted increase in dollars (0 when none, or when the grant was for another day). */
export async function spendOverrideToday(): Promise<number> {
  return (await readOverride())?.extraUsd ?? 0;
}

/** The cap actually in force right now: the standing budget plus any same-day grant. */
export async function effectiveDayMaxUsd(): Promise<number> {
  return dayMaxCostUsd() + (await spendOverrideToday());
}

/**
 * Grant (or extend) today's increase. Additive rather than absolute so a second "+$20" tops up
 * instead of silently replacing the first — the owner is answering "give me more", not restating
 * a total, and treating it as a total would quietly REVOKE an earlier grant.
 */
export async function grantSpendIncrease(extraUsd: number, grantedBy: string, reason?: string): Promise<{ extraUsd: number; effectiveCap: number }> {
  const current = await readOverride();
  const extra = Math.max(0, (current?.extraUsd ?? 0) + extraUsd);
  await writeOverride({ extraUsd: extra }, grantedBy, reason);
  await logEvent("spend.cap_raised", { extraUsd, totalExtra: extra, grantedBy, reason }, { level: "warn" }).catch(() => {});
  return { extraUsd: extra, effectiveCap: dayMaxCostUsd() + extra };
}

// ── Same-day RUN cap increase ────────────────────────────────────────────────
// Same shape as the spend raise, and for the same reason. The run cap exists so the autopilot
// cannot spawn unbounded work; it becomes a problem on the day there is legitimately a lot of work
// and a real deadline. Additive, today-only, and it expires by construction.
//
// Kept as its own ceiling rather than folded into spend because the two catch different runaways: a
// run cap bounds HOW MANY things start, a spend cap bounds how expensive they get. Raising one
// should not silently raise the other — a day that needs 30 cheap runs is not a day that needs
// permission to spend triple.

/** Today's granted extra runs (0 when none, or when the grant was for another day). */
export async function runOverrideToday(): Promise<number> {
  return (await readOverride())?.extraRuns ?? 0;
}

/** The run cap actually in force: standing cap plus any same-day grant. */
export async function effectiveDailyRunCap(): Promise<number> {
  return dailyRunCap() + (await runOverrideToday());
}

/** Additive, so a second grant tops up rather than silently revoking the first. */
export async function grantRunIncrease(extraRuns: number, grantedBy: string, reason?: string): Promise<{ extraRuns: number; effectiveCap: number }> {
  const current = await readOverride();
  const extra = Math.max(0, Math.floor((current?.extraRuns ?? 0) + extraRuns));
  await writeOverride({ extraRuns: extra }, grantedBy, reason);
  await logEvent("runs.cap_raised", { extraRuns, totalExtra: extra, grantedBy, reason }, { level: "warn" }).catch(() => {});
  return { extraRuns: extra, effectiveCap: dailyRunCap() + extra };
}

/**
 * True while today's known spend is under the cap IN FORCE (standing budget + any grant) and, when
 * the OS sets max_calls_per_day, today's model-call count is under it. Gates the AUTO paths.
 */
export async function withinSpendBudget(): Promise<boolean> {
  if ((await spendToday()) >= (await effectiveDayMaxUsd())) return false;
  const callCap = dailyModelCallCap();
  return callCap === null || (await modelCallsToday()).calls < callCap;
}

/** A task's own accumulated model-call count + known cost — for the per-task runaway breaker. */
export async function taskSpend(taskId: string): Promise<{ calls: number; costUsd: number }> {
  const rows = await store.modelCalls.find((c) => c.taskId === taskId);
  return { calls: rows.length, costUsd: rows.reduce((s, c) => s + (c.costUsd ?? 0), 0) };
}
/** True if a task has blown its per-task call OR cost cap (checked before re-running it). */
export async function taskOverBudget(taskId: string): Promise<boolean> {
  const { calls, costUsd } = await taskSpend(taskId);
  return calls >= taskMaxModelCalls() || costUsd >= taskMaxCostUsd();
}

/**
 * Which client work is blocked right now, and what it is due.
 *
 * A page that says "spend cap reached" asks the owner to make a money decision with no basis for it.
 * The only thing that makes a raise obviously right or obviously wrong is what it unblocks, so the
 * request names the clients and the deadlines rather than the dollar figure alone.
 *
 * Sorted by urgency — overdue first, then soonest — because if the list is truncated the entries
 * that survive should be the ones that would actually decide the answer.
 */
export async function blockedWorkContext(limit = 4): Promise<string[]> {
  try {
    const [projects, clients] = await Promise.all([store.projects.all(), store.clients.all()]);
    const today = new Date().toISOString().slice(0, 10);
    const named = new Map(clients.map((c) => [c.id, c.name]));

    return projects
      .filter((p) => p.status === "active" && p.targetEndDate)
      .sort((a, b) => (a.targetEndDate ?? "").localeCompare(b.targetEndDate ?? ""))
      .slice(0, limit)
      .map((p) => {
        const due = p.targetEndDate!;
        const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
        const when = days < 0 ? `${Math.abs(days)}d OVERDUE` : days === 0 ? "due today" : `due in ${days}d`;
        return `${named.get(p.clientId) ?? "unknown client"} — ${p.name} (${when})`;
      });
  } catch {
    return []; // context is a nicety; never let it break the page that matters
  }
}
