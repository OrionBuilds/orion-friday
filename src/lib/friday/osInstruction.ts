// FRIDAY "friday.instruction" — the generic OS task handler. The owner describes a schedule in plain
// words in the OS; the OS confirms a brief with them and stores it on the schedule as
// config.instructions (+ summary, scope, success_criteria, output_destination, external_effects and a
// capped transcript). Every run of that schedule lands here and is fed to FRIDAY's normal planner
// (orchestrate) as owner-sanctioned standing work — requestOrigin "scheduler", the same origin the
// authority model already defines for OS-scheduled runs.
//
// Three paths, decided per run:
//   shadow    (env gate or schedule not 'active') — plan only: one read-only completeJSON call says
//             what FRIDAY WOULD do. Nothing is created, dispatched or sent.
//   approval  (run.approval_required, or config.external_effects names an outward send) — the same
//             read-only plan + draft is parked via requestApproval; orchestrate runs only in the
//             deliver handler, after a human approved exactly what was shown. Nothing outward ever
//             happens inside the handler.
//   active    — orchestrate(prompt) now; summary + created task/run/approval ids go on the run report.
//
// Idempotency: runs re-present (lost report, lease expiry) and approved deliveries re-present (lost
// deliver_confirm). A local link row keyed by run id (deliveries: "deliver:<run id>") is written
// BEFORE orchestrate and completed after it, so a re-presented run replays the recorded outcome
// instead of planning the same work twice — and one that died mid-orchestrate is reported, not re-run.
//
// Logic is dependency-injected (same split as osRequests/osRequestsRuntime) so the unit tests never
// touch the store, an engine or the OS; defaultInstructionDeps() is the real wiring.

import type { DueRun, ResolvedRun, PollContext, HandlerResult } from "@autom8ionlab/agent-core";

export const INSTRUCTION_TASK_KEY = "friday.instruction";

/** One row per handled run (or delivery). `status` drives replay on re-presentation. */
export interface InstructionLink {
  id: string; // run id, or "deliver:<run id>"
  status: "started" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface InstructionPlan {
  summary: string;
  steps: string[];
  /** Draft of anything that would leave the building (message body, post, report). May be empty. */
  draft: string;
}

export interface OrchestrateOutcome {
  reply: string;
  intent?: string;
  projectId?: string | null;
  taskIds: string[];
  runIds: string[];
  approvalIds: string[];
}

export interface InstructionDeps {
  /** Read-only planning call (no tools, no writes). null = model unavailable. */
  plan: (prompt: string) => Promise<InstructionPlan | null>;
  /** FRIDAY's planner with real side effects (tasks, dispatch). */
  orchestrate: (message: string) => Promise<OrchestrateOutcome>;
  links: {
    get: (id: string) => Promise<InstructionLink | null>;
    insert: (l: InstructionLink) => Promise<unknown>;
    update: (id: string, patch: Partial<InstructionLink>) => Promise<unknown>;
  };
  now: () => string;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A config field as display text: strings trimmed, lists joined, objects JSON'd, empties dropped. */
function text(v: unknown, max = 2000): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => text(x, max)).filter(Boolean).join("; ").slice(0, max);
  try { return JSON.stringify(v).slice(0, max); } catch { return ""; }
}

const NO_EFFECT = /^(none|no|false|n\/a|nothing|-)?$/i;

/** Does config.external_effects say this run sends something outward? true, a non-empty list of
 *  real entries, or a non-"none" string all count; false / [] / "none" / absent do not. */
export function externalEffects(config: Record<string, unknown> | undefined): string[] {
  const v = config?.external_effects;
  if (v === true) return ["external effects declared"];
  if (Array.isArray(v)) return v.map((x) => text(x, 200)).filter((s) => s && !NO_EFFECT.test(s));
  if (typeof v === "string") return NO_EFFECT.test(v.trim()) ? [] : [v.trim().slice(0, 200)];
  return [];
}

/** The validated brief, or an error naming what is wrong. */
export function readInstructions(config: Record<string, unknown> | undefined): { ok: true; instructions: string } | { ok: false; error: string } {
  const v = config?.instructions;
  if (typeof v !== "string") {
    return { ok: false, error: `${INSTRUCTION_TASK_KEY}: schedule config.instructions is ${v == null ? "missing" : `a ${Array.isArray(v) ? "list" : typeof v}, not text`} — re-confirm the task brief in the OS` };
  }
  if (!v.trim()) return { ok: false, error: `${INSTRUCTION_TASK_KEY}: schedule config.instructions is empty — re-confirm the task brief in the OS` };
  return { ok: true, instructions: v.trim().slice(0, 8000) };
}

/** What FRIDAY is asked to do for this run. Provenance first so the planner knows who is asking. */
export function instructionPrompt(run: Pick<DueRun, "run_id" | "title" | "scheduled_for" | "config">, instructions: string): string {
  const c = run.config ?? {};
  const effects = externalEffects(c);
  const lines = [
    `Scheduled task from the owner's OS schedule "${clip(run.title, 160) || "untitled"}" (run ${run.run_id}, scheduled for ${run.scheduled_for}). The owner set this up and confirmed the brief; it is their standing ask.`,
    "",
    "Instructions:",
    instructions,
  ];
  const extra: Array<[string, string]> = [
    ["Summary", text(c.summary, 600)],
    ["Scope", text(c.scope)],
    ["Success criteria", text(c.success_criteria)],
    ["Output destination", text(c.output_destination, 600)],
    ["External effects", effects.join("; ")],
  ];
  const present = extra.filter(([, v]) => v);
  if (present.length) lines.push("", ...present.map(([k, v]) => `${k}: ${v}`));
  return lines.join("\n");
}

const PLAN_SYSTEM =
  "You are FRIDAY, an operations agent, PLANNING (not executing) one run of a scheduled task the owner " +
  "set up. Do not claim anything was done. Return strict JSON only: " +
  `{"summary": "<one sentence: what this run would do>", "steps": ["<concrete step>", ...], ` +
  `"draft": "<the full draft of any message/post/report that would be sent or published externally, or empty string if none>"}. ` +
  "At most 8 steps, each one short line.";

/** Normalise the planner's JSON; null when it is unusable. */
export function normalizePlan(raw: unknown): InstructionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { summary?: unknown; steps?: unknown; draft?: unknown };
  const steps = Array.isArray(r.steps) ? r.steps.map((s) => clip(text(s, 300), 300)).filter(Boolean).slice(0, 8) : [];
  const summary = clip(typeof r.summary === "string" ? r.summary : "", 400);
  if (!summary && !steps.length) return null;
  return { summary: summary || steps[0], steps, draft: typeof r.draft === "string" ? r.draft.trim().slice(0, 6000) : "" };
}

function planText(p: InstructionPlan | null): string {
  if (!p) return "(plan unavailable — the planning model did not answer; the brief above is what would run)";
  return [p.summary, ...p.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n");
}

function outcomeResult(o: OrchestrateOutcome): Record<string, unknown> {
  return {
    reply: clip(o.reply, 2000),
    intent: o.intent ?? null,
    project_id: o.projectId ?? null,
    task_ids: o.taskIds,
    run_ids: o.runIds,
    approval_ids: o.approvalIds,
  };
}

function outcomeSummary(prefix: string, o: OrchestrateOutcome): string {
  const counts = `${o.taskIds.length} task(s) created, ${o.runIds.length} dispatched, ${o.approvalIds.length} awaiting FRIDAY approval`;
  return clip(`${prefix}: ${counts}. ${o.reply}`, 900);
}

/**
 * Run `work` at most once per link id. A re-presented id replays the recorded outcome ("done"),
 * re-raises the recorded error ("failed"), or — when a previous attempt started and never recorded
 * anything (process died mid-orchestrate) — reports that instead of risking duplicate tasks.
 */
async function once(
  d: InstructionDeps,
  id: string,
  work: () => Promise<{ summary: string; result: Record<string, unknown> }>,
): Promise<{ summary: string; result: Record<string, unknown> }> {
  const prior = await d.links.get(id);
  if (prior?.status === "done") {
    return { summary: prior.summary ?? "already handled", result: { ...(prior.result ?? {}), replayed: true } };
  }
  if (prior?.status === "failed") throw new Error(prior.error ?? `${INSTRUCTION_TASK_KEY}: previous attempt failed`);
  if (prior?.status === "started") {
    return {
      summary: `A previous attempt (started ${prior.startedAt}) did not record an outcome; not re-running it so the work is not planned twice.`,
      result: {
        replayed: true,
        interrupted: true,
        alerts: [{
          kind: "instruction.interrupted",
          text: `${INSTRUCTION_TASK_KEY} ${id} started at ${prior.startedAt} but never recorded an outcome — check FRIDAY's board for tasks it may have created.`,
          priority: "warn",
          dedupeKey: `instruction.interrupted:${id}`,
        }],
      },
    };
  }
  await d.links.insert({ id, status: "started", startedAt: d.now() });
  try {
    const out = await work();
    await d.links.update(id, { status: "done", finishedAt: d.now(), summary: out.summary, result: out.result });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await d.links.update(id, { status: "failed", finishedAt: d.now(), error: clip(error, 500) }).catch(() => {});
    throw e;
  }
}

/** The "friday.instruction" task handler. Throws (→ run failed) only on a bad brief or a failed orchestrate. */
export async function instructionTask(run: DueRun, ctx: PollContext, d: InstructionDeps): Promise<HandlerResult> {
  const brief = readInstructions(run.config);
  if (!brief.ok) throw new Error(brief.error);

  const prompt = instructionPrompt(run, brief.instructions);
  const shadow = ctx.mode !== "active" || run.mode !== "active";
  const effects = externalEffects(run.config);
  const needsApproval = run.approval_required === true || effects.length > 0;

  if (shadow || needsApproval) {
    // Read-only: completeJSON with no write/os access. A dead model is not a failed run — the brief
    // itself is still a faithful description of what would run.
    const plan = await d.plan(prompt).catch(() => null);
    const label = clip(run.title, 120) || "Scheduled instruction";
    const result: Record<string, unknown> = {
      path: needsApproval ? "approval" : "shadow",
      shadow,
      plan,
      external_effects: effects,
      scheduled_for: run.scheduled_for,
    };
    const summary = clip(
      `${shadow ? "Shadow plan" : "Awaiting approval"} — ${label}: ${plan?.summary ?? "plan unavailable (model did not answer)"}`,
      900,
    );
    if (!needsApproval) return { summary, result };
    // The approved payload travels in the run result, so the deliver handler executes exactly what
    // the approver saw (same rule as os_data_hygiene) rather than re-planning after the fact.
    result.instruction = { prompt, plan_text: planText(plan), draft: plan?.draft ?? "" };
    return {
      summary,
      result,
      // Returned in shadow too: agent-core reports it shadow:true (no approval row, logged as
      // would_fire) and an approval_required run is not flagged approval.contract_gap.
      requestApproval: {
        title: `${label} — approve this run`,
        description:
          `FRIDAY prepared this scheduled run but did nothing yet.` +
          (effects.length ? ` It would act outside FRIDAY: ${effects.join("; ")}.` : "") +
          ` Approving runs it through FRIDAY's planner exactly as described; rejecting does nothing.\n\nPlan:\n${planText(plan)}`,
        draft_content: {
          instructions: brief.instructions,
          plan: plan?.steps ?? [],
          draft: plan?.draft ?? "",
          external_effects: effects,
          output_destination: text(run.config?.output_destination, 600),
          scheduled_for: run.scheduled_for,
        },
        action_type: "agent_instruction_run",
      },
    };
  }

  return once(d, run.run_id, async () => {
    const out = await d.orchestrate(prompt);
    return { summary: outcomeSummary("Instruction run", out), result: { path: "active", scheduled_for: run.scheduled_for, ...outcomeResult(out) } };
  });
}

/** deliver["friday.instruction"]: runs only after a human approved. Executes the approved prompt +
 *  plan; nothing to deliver (malformed result) is a no-op, never a re-plan. */
export async function deliverInstruction(r: ResolvedRun, _ctx: PollContext, d: InstructionDeps): Promise<{ delivery?: Record<string, unknown> }> {
  const ins = (r.result as { instruction?: { prompt?: unknown; plan_text?: unknown; draft?: unknown } } | undefined)?.instruction;
  const prompt = typeof ins?.prompt === "string" ? ins.prompt.trim() : "";
  if (!prompt) return { delivery: { note: "nothing to deliver — the approved run carried no instruction" } };
  const planned = typeof ins?.plan_text === "string" ? ins.plan_text : "";
  const draft = typeof ins?.draft === "string" ? ins.draft.trim() : "";
  const message = [
    prompt,
    "",
    "The owner APPROVED this run as planned below; carry it out now.",
    planned && `Approved plan:\n${planned}`,
    draft && `Approved draft (send/publish this content as written):\n${draft}`,
  ].filter(Boolean).join("\n\n");
  // A delivery whose orchestrate already failed once is confirmed WITH the error rather than
  // re-thrown: agent-core retries a throwing deliver every poll, forever, and the failure would sit in
  // a log nobody reads. The first failure still throws, so the run re-presents and lands here.
  const prior = await d.links.get(`deliver:${r.run_id}`);
  if (prior?.status === "failed") return { delivery: { failed: true, error: prior.error ?? "approved run failed" } };
  const out = await once(d, `deliver:${r.run_id}`, async () => {
    const o = await d.orchestrate(message);
    return { summary: outcomeSummary("Approved instruction run", o), result: outcomeResult(o) };
  });
  return { delivery: { summary: out.summary, ...out.result } };
}

/** Real wiring. Dynamic imports keep the store/engines/planner out of the module graph for tests. */
export async function defaultInstructionDeps(): Promise<InstructionDeps> {
  const [{ Collection }, { FRIDAY_DATA_DIR }, { completeJSON }] = await Promise.all([
    import("@autom8ionlab/agent-core"),
    import("@/lib/persistence/store"),
    import("@/lib/friday/engines"),
  ]);
  const links = new Collection<InstructionLink>(FRIDAY_DATA_DIR, "os_instruction_runs");
  return {
    plan: async (prompt) =>
      normalizePlan(await completeJSON<unknown>({ system: PLAN_SYSTEM, prompt, json: true, temperature: 0, timeoutMs: 120_000 })),
    orchestrate: async (message) => {
      const { orchestrate } = await import("@/lib/friday/orchestrator");
      // Owner-sanctioned standing work: origin "scheduler" (authority.ts — Tier 1 except money,
      // contracts and the critical-risk floor, which still get an owner OK through FRIDAY's queue).
      const out = await orchestrate(message, { channel: "web", requestOrigin: "scheduler" });
      return {
        reply: out.reply,
        intent: out.intent,
        projectId: out.project?.id ?? null,
        taskIds: out.tasks.map((t) => t.id),
        runIds: out.runs.map((x) => x.id),
        approvalIds: out.approvals.map((a) => a.id),
      };
    },
    links: {
      get: (id) => links.get(id),
      insert: (l) => links.insert(l),
      update: (id, p) => links.update(id, p),
    },
    now: () => new Date().toISOString(),
  };
}
