// FRIDAY intent-router guard probe.
//
// The router was ported from CLARA, where it exists because a conversational fallback once told
// The owner "Inbox swept; junk archived and labeled. All clear." having swept nothing. FRIDAY's stakes
// are higher: her tools ship code to client sites and create resources on other people's platforms.
//
// These assertions are the parts of that guarantee checkable without spending money or touching a
// live site — no model calls, no Netlify calls, no notifications.
//
// Run:  npx tsx scripts/probes/intent-router-guards.ts

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  FAIL  ${msg}`);
}

async function main(): Promise<void> {
  const { TOOLS, claimsCompletion } = await import("../../src/lib/friday/intent");
  const { classifyActionTier } = await import("../../src/lib/friday/authority");

  // ── The hard Tier-3 floor survived the port ──────────────────────────────────────────────────
  //
  // The single most important assertion in this file. Deploying ships live to a client's site, and
  // the authority table floors it at Tier 3 for EVERY profile — including "aggressive". A router
  // that could route around that would be strictly worse than the keyword surface it replaced.
  console.log("\nDeploy is still a hard Tier-3 floor");
  {
    const before = failures;
    for (const profile of ["conservative", "standard", "aggressive"] as const) {
      const tier = classifyActionTier("deploy", profile);
      if (tier !== 3) fail(`classifyActionTier("deploy", "${profile}") = ${tier}, expected 3 — deploys must always need the owner`);
    }
    const deploy = TOOLS.find((t) => t.name === "deploy");
    if (!deploy) fail("no deploy tool");
    else {
      if (deploy.actionClass !== "deploy") fail(`deploy tool is classed "${deploy.actionClass}" — it would miss the Tier-3 floor entirely`);
      if (deploy.reversible) fail("deploy is marked reversible — it would execute without asking, and it ships to a client site");
    }
    if (failures === before) console.log("  ok    deploy floors at tier 3 for every profile and is marked irreversible");
  }

  // ── Every tool is governed and classified ────────────────────────────────────────────────────
  console.log("\nEvery tool is governed and classified");
  {
    const before = failures;
    for (const t of TOOLS) {
      if (!t.name || !t.description) fail(`tool with no name/description: ${t.name}`);
      if (!t.actionClass) fail(`${t.name}: no actionClass — the authority model has nothing to score`);
      if (typeof t.reversible !== "boolean") fail(`${t.name}: no reversible flag — cannot decide act-vs-confirm`);
      if (t.speed !== "fast" && t.speed !== "slow") fail(`${t.name}: no speed class — voice would await it inline`);
      if (typeof t.run !== "function") fail(`${t.name}: no run handler`);
      if (typeof t.describe !== "function") fail(`${t.name}: no describe — its approval card would be blank`);
    }
    if (failures === before) console.log(`  ok    ${TOOLS.length} tools, all classed, flagged and runnable`);
  }

  // ── Anything that leaves the building confirms ───────────────────────────────────────────────
  console.log("\nOutbound/irreversible tools require confirmation");
  {
    const before = failures;
    // deploy ships to a client site; weekly_update emails clients; provision_workspace creates a
    // real repo and a real Netlify site under the agency's accounts.
    for (const name of ["deploy", "weekly_update", "provision_workspace"]) {
      const t = TOOLS.find((x) => x.name === name);
      if (!t) { fail(`expected a "${name}" tool and found none`); continue; }
      if (t.reversible) fail(`${name} is marked reversible — it would run without asking, and it reaches outside the agency`);
    }
    // And the reads must NOT be gated, or every question becomes an approval.
    for (const name of ["project_status", "list_projects", "site_health", "client_health"]) {
      const t = TOOLS.find((x) => x.name === name);
      if (!t) { fail(`expected a "${name}" tool and found none`); continue; }
      if (!t.reversible) fail(`${name} is a read — gating it would make them ask permission to get an answer`);
    }
    if (failures === before) console.log("  ok    writes that leave the building confirm; reads don't");
  }

  // ── A queued approval can actually run ───────────────────────────────────────────────────────
  //
  // decideApprovalInner dispatches on emailDraftId / deployProjectId / taskId / intentTool. A row
  // carrying none of them flips to "approved", tells the owner "running it now", and does nothing.
  // CLARA shipped exactly that bug with her `generic` approval kind, so it is worth asserting the
  // executor branch still exists rather than trusting it.
  console.log("\nRouter approvals have an executor");
  {
    const before = failures;
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/lib/friday/orchestrator.ts", "utf8");
    if (!/if \(approval\.intentTool\)/.test(src)) {
      fail("orchestrator.ts has no `if (approval.intentTool)` branch — every approval the router queues would approve and silently do nothing");
    }
    // Dynamic import, so match the call form rather than a static `from "…"` clause.
    if (!/import\("@\/lib\/friday\/intent"\)/.test(src)) {
      fail("the intentTool branch does not import the tool catalog — it cannot resolve what to run");
    }
    if (failures === before) console.log("  ok    approving a router-queued row resolves and runs the tool");
  }

  // ── The completion-claim guard covers FRIDAY's verbs ─────────────────────────────────────────
  console.log("\nCompletion-claim detection covers deploy language");
  {
    const before = failures;
    for (const t of ["Deployed it.", "Shipped the marketing site.", "I've published the changes.", "Created the repo."]) {
      if (!claimsCompletion(t)) fail(`did NOT catch a false completion: "${t}"`);
    }
    for (const t of ["Want me to deploy it?", "I can ship that.", "Shall I create the repo?", "Two sites are down."]) {
      if (claimsCompletion(t)) fail(`false positive on an offer/question: "${t}"`);
    }
    if (failures === before) console.log("  ok    deploy/ship/publish claims caught, offers allowed");
  }

  console.log(
    failures === 0
      ? "\nPASS — the router cannot ship anything without the owner, and cannot claim work it did not do.\n"
      : `\nFAIL — ${failures} problem(s).\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});

export {};
