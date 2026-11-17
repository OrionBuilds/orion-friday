import type { NextConfig } from "next";
import path from "path";

// FRIDAY's parent — the common ancestor of FRIDAY and the sibling shared package
// (../agent-core). Turbopack (Next 16's default for both dev and `next build`) treats any
// module resolved outside its `root` as an external package and falls back to a raw Node
// require(), which can't load un-built .ts source — exactly what broke CLARA's old @friday-core
// alias attempt. Widening root to the shared ancestor is Next's documented fix for a workspace
// package that lives as a sibling directory rather than nested under the app.
const workspaceRoot = path.resolve(__dirname, "..");

const nextConfig: NextConfig = {
  // Next 16 dev blocks the /_next/* client runtime for non-localhost origins unless they're
  // allow-listed here. Required so the app works when reached via a tunnel hostname (set
  // FRIDAY_DEV_ORIGINS, comma-separated) — without it the page renders but never hydrates (dead buttons).
  allowedDevOrigins: (process.env.FRIDAY_DEV_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  turbopack: {
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
  // Local shared package (../agent-core, linked via "file:" dependency below) — Next
  // transpiles its un-built TS source directly under both Webpack and Turbopack.
  transpilePackages: ["@autom8ionlab/agent-core"],
};

export default nextConfig;
