import { NextResponse } from "next/server";
import { run } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Process-wide cache + in-flight de-dupe.
// Without this, every Vitals/Overview tick spawns 5 CLI processes; with multiple
// open dashboard tabs that's ~15 forks every 4s. Cache for 5s, coalesce concurrent
// requests onto one inflight Promise. CLI statuses don't change faster than this.
const CACHE_TTL_MS = 5000;
let cached: { ts: number; body: unknown } | null = null;
let inflight: Promise<unknown> | null = null;

async function computeVitals() {
  const [claude, hermes, antigravity] = await Promise.all([
    run("claude", ["--version"], { timeoutMs: 6000 }),
    run("hermes", ["status"], { timeoutMs: 8000 }),
    run("antigravity", ["--version"], { timeoutMs: 6000 }),
  ]);
  return { claude, hermes, antigravity };
}

export async function GET() {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { "X-Vitals-Cache": "hit" } });
  }
  if (!inflight) {
    inflight = computeVitals().finally(() => { inflight = null; });
  }
  const { claude, hermes, antigravity } = (await inflight) as Awaited<ReturnType<typeof computeVitals>>;

  const hermesModel = (() => {
    const m = hermes.stdout.match(/Model:\s+(\S+)/);
    return m ? m[1] : "unknown";
  })();
  const hermesProvider = (() => {
    const m = hermes.stdout.match(/Provider:\s+([^\n]+)/);
    return m ? m[1].trim() : "unknown";
  })();

  const body = {
    ts: Date.now(),
    claude: {
      ok: claude.ok,
      version: claude.stdout.trim() || claude.stderr.trim(),
      latencyMs: claude.durationMs,
    },
    hermes: {
      ok: hermes.ok,
      model: hermesModel,
      provider: hermesProvider,
      latencyMs: hermes.durationMs,
      raw: hermes.stdout.slice(0, 2000),
    },
    antigravity: {
      ok: antigravity.ok,
      version: antigravity.stdout.trim() || antigravity.stderr.trim(),
      latencyMs: antigravity.durationMs,
    },
  };
  cached = { ts: now, body };
  return NextResponse.json(body, { headers: { "X-Vitals-Cache": "miss" } });
}
