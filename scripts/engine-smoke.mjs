// FRIDAY engine smoke test — dispatches one canonical task per engine lane and asserts REAL
// execution (the right engine actually served it, no silent tool-less fallback, and coding lanes
// produced a verified change). Turns "are all agents actually working?" into one command.
//
//   node scripts/engine-smoke.mjs                 # safe lanes only: lmstudio, codex
//   node scripts/engine-smoke.mjs all             # every lane (needs claude/hermes/agy authed)
//   node scripts/engine-smoke.mjs codex,hermes    # specific lanes
//
// Grading uses the G1 guardrail fields now persisted on each run (servedEngine / fellBack /
// verificationFailed) — so a lane that silently fell back to LM Studio is a FAIL, not a fake PASS.
//
// Prereqs: FRIDAY dev server running on :3737. Coding lanes (codex/claude) need a project with a
// git repo attached — pass PROJECT_ID env or the script creates a scratch project you must attach a
// throwaway repo to first (it will tell you).

const BASE = process.env.FRIDAY_BASE || "http://127.0.0.1:3737";
const PROJECT_ID = process.env.PROJECT_ID || "";

// lane → { role, prompt, coding } — role determines the engine via the agent registry.
const LANES = {
  lmstudio:    { role: "marketing",   coding: false, title: "Smoke: draft one 6-word tagline for a coffee brand." },
  codex:       { role: "debug",       coding: true,  title: "Smoke: create a file SMOKE.txt containing 'ok' and commit it (no PR needed)." },
  claude:      { role: "dev",         coding: true,  title: "Smoke: create a file SMOKE_CLAUDE.txt containing 'ok' and commit it (no PR needed)." },
  hermes:      { role: "research-qa", coding: false, title: "Smoke: in one sentence, what is the capital of France?" },
  antigravity: { role: "automation",  coding: false, title: "Smoke: report the current date. One line." },
};

const args = (process.argv[2] || "lmstudio,codex").toLowerCase();
const lanes = args === "all" ? Object.keys(LANES) : args.split(",").map((s) => s.trim()).filter((l) => LANES[l]);

async function j(path, opts) { const r = await fetch(BASE + path, opts); return r.json(); }
async function post(path, body) { return j(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

async function resolveProject() {
  if (PROJECT_ID) return PROJECT_ID;
  const { projects } = await j("/api/friday/projects").catch(() => ({ projects: [] }));
  const list = projects || [];
  const found = list.find((p) => /engine smoke/i.test(p.name));
  if (found) return found.id;
  console.log("No PROJECT_ID set and no 'Engine Smoke' project found. Set PROJECT_ID=<id> to a project");
  console.log("that has a throwaway git repo attached (coding lanes need it). Non-coding lanes still run.");
  return list[0]?.id || null;
}

async function pollRun(taskId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { runs } = await j(`/api/friday/runs?taskId=${taskId}`);
    const run = (runs || [])[0];
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

function grade(lane, run) {
  if (!run) return { pass: false, why: "timed out / no run" };
  const served = run.servedEngine || "?";
  if (run.status === "error") return { pass: false, why: `error: ${(run.error || "").slice(0, 80)} [served ${served}]` };
  if (run.fellBack) return { pass: false, why: `fell back ${run.intendedEngine}→${served} (engine unavailable)` };
  if (served !== lane) return { pass: false, why: `served by ${served}, expected ${lane}` };
  if (LANES[lane].coding && run.verificationFailed) return { pass: false, why: "no verified commit/PR — didn't really run" };
  return { pass: true, why: `served ${served}${run.verificationFailed === false && LANES[lane].coding ? ", real change verified" : ""}` };
}

const projectId = await resolveProject();
console.log(`\nEngine smoke test → ${lanes.join(", ")}  (project ${projectId || "none"})\n`);
const results = [];
for (const lane of lanes) {
  const L = LANES[lane];
  process.stdout.write(`  ${lane.padEnd(12)} dispatching (${L.role})… `);
  const t = await post("/api/friday/tasks", { projectId, title: L.title, assignee: L.role, status: "planning" });
  if (!t.task) { console.log("FAIL (task create)"); results.push([lane, false, "task create failed"]); continue; }
  const d = await post("/api/friday/tasks/dispatch", { taskId: t.task.id });
  if (d.approval) { console.log("gated (approval) — skipping"); results.push([lane, null, "hit approval gate"]); continue; }
  const run = await pollRun(t.task.id, L.coding ? 640000 : 300000);
  const g = grade(lane, run);
  console.log(g.pass ? `PASS — ${g.why}` : `FAIL — ${g.why}`);
  results.push([lane, g.pass, g.why]);
}

console.log("\n── Summary ──");
for (const [lane, pass, why] of results) console.log(`  ${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"}  ${lane.padEnd(12)} ${why}`);
const failed = results.filter((r) => r[1] === false).length;
console.log(`\n${failed === 0 ? "✅ all tested lanes execute" : `❌ ${failed} lane(s) not executing`}\n`);
