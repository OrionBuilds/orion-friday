// Read-only probe: build the structured status for one project from the local store (+ best-effort
// GitHub / Netlify / OS / vault) and print the prose the owner would get in chat.
//
//   node --experimental-transform-types --import ./scripts/test/register.mjs scripts/probes/project-status.ts "acme"
//   node ... scripts/probes/project-status.ts --portfolio

import { resolveStatusSubject, buildProjectStatus, buildPortfolioStatus, renderStatusProse } from "../../src/lib/friday/statusReport";

const arg = process.argv.slice(2).join(" ").trim();
async function main() {
  if (!arg || arg === "--portfolio") {
    const pf = await buildPortfolioStatus();
    console.log(renderStatusProse(pf, { channel: "chat" }));
    console.log("\nsources:", pf.sources.filter((s) => !s.ok).map((s) => `${s.name}: ${s.note}`).join("; ") || "all ok");
    return;
  }
  const r = await resolveStatusSubject({ type: "project", name: arg });
  if (!r) { console.log(`not found: ${arg}`); return; }
  if ("candidates" in r) { console.log("ambiguous:", r.candidates.map((c) => c.name).join(", ")); return; }
  const sr = await buildProjectStatus(r.project);
  console.log(renderStatusProse(sr, { channel: "chat" }));
  console.log("\n--- sms ---\n" + renderStatusProse(sr, { channel: "sms" }));
  console.log("\nsources:");
  for (const s of sr.sources) console.log(`  ${s.ok ? "ok " : "err"} ${s.name}${s.note ? ` — ${s.note}` : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
