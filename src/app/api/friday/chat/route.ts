import { NextResponse } from "next/server";
import { orchestrate } from "@/lib/friday/orchestrator";
import { store, newId, nowISO, logEvent } from "@/lib/persistence/store";
import { verifyInteragentSecret, sanitizeImages } from "@autom8ionlab/agent-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// FRIDAY command channel: an operator message in, a materialised plan out. Also the entry
// point for CLARA's delegation bridge (`from` identifies the caller for logging —
// see @autom8ionlab/agent-core's interagent module; auth is a no-op unless
// INTERAGENT_SHARED_SECRET is configured, so FRIDAY's own web UI is unaffected).
// P2.7 thread read-back. orchestrate() has appended every web turn to store.messages since day
// one, but only sms/voice ever read it back — a reload of FRIDAY's own UI (or the Office desk)
// started from a blank transcript while the durable record sat on disk. Returns the last N
// web-channel owner↔friday turns, oldest first, in the store's native {role, text, ts} shape.
export async function GET(req: Request) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 30, 1), 100);
  const rows = await store.messages.tail(limit, (m) => m.channel === "web" && (m.role === "user" || m.role === "friday"));
  return NextResponse.json({ messages: rows.map((m) => ({ role: m.role, text: m.text, ts: m.ts })) });
}

export async function POST(req: Request) {
  if (!verifyInteragentSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  // Screenshots/photos for this turn (Office desk upload): validated, capped, never thrown on.
  const images = sanitizeImages(body.images);
  if (!message && !images.length) return NextResponse.json({ error: "message required" }, { status: 400 });
  const projectId = body.projectId ? String(body.projectId) : undefined;
  const channel = body.channel === "sms" || body.channel === "voice" ? body.channel : "web";
  const from = typeof body.from === "string" ? body.from.slice(0, 40) : undefined;
  const history = Array.isArray(body.history)
    ? body.history.filter((h: { role?: unknown; text?: unknown }) => h && typeof h.text === "string").map((h: { role: string; text: string }) => ({ role: h.role, text: h.text }))
    : undefined;
  // The whole conversational path, shared by both response modes: router first, planner fallback.
  //
  // The intent router runs BEFORE the planner — the same ordering the SMS channel has always
  // used (see api/channels/twilio/inbound). Without this the web chat went straight to
  // orchestrate(), so every router tool was reachable by text message but not by typing in her
  // own UI: asking "what's on my calendar" produced a planner reply that NARRATED reading the
  // calendar without ever calling it. That is the precise failure the router exists to prevent.
  //
  // It deliberately does not claim ordinary conversation: no tool call and no clarifying question
  // means fall through to the planner exactly as before, so work-shaped requests are unaffected.
  // Origin-aware autonomy (2026-09): who is asking? `from: "clara"` is only trusted when the
  // interagent secret is configured — verifyInteragentSecret above already passed, so with a secret
  // set the caller proved it holds it; without one `from` is a free-text field anyone on loopback
  // can write, and an unverifiable "clara" must not buy CLARA's (owner-sanctioned) autonomy.
  // Either way the result is owner-tier: CLARA only relays the owner's asks.
  const requestOrigin: import("@/lib/friday/types").RequestOrigin =
    from === "clara" && !!process.env.INTERAGENT_SHARED_SECRET ? "clara" : "owner";
  const respond = async (onToken?: (text: string) => void): Promise<Record<string, unknown>> => {
    // "resume <repo>" after a malware-suspected block — deterministic, before the router, so it never
    // depends on a model call (and CLARA's relay reaches it too).
    // Lifting a malware block is the owner's call: only honoured when the caller proved the interagent
    // secret (CLARA relaying them, or their own authenticated UI). Without a configured secret, loopback
    // callers are unauthenticated, so the command is refused rather than trusted.
    const { tryResumeCommand, parseResumeCommand } = await import("@/lib/friday/wormGuard");
    if (parseResumeCommand(message)) {
      const verified = !!process.env.INTERAGENT_SHARED_SECRET;
      const resumed = verified ? await tryResumeCommand(message) : "I can only lift a malware block from a verified channel — text me, reply to my email, or ask through CLARA.";
      // A recognized resume that names no blocked repo is answered here too — it never goes on to
      // the model router or task planning.
      const reply = resumed ?? `Nothing called "${parseResumeCommand(message)}" is blocked for suspected malware, so there's nothing to resume.`;
      return { reply, intent: "chat", tasks: [], runs: [], approvals: [] };
    }
    const { runIntent } = await import("@/lib/friday/intent");
    // P2.7: prior turns as router context (orchestrate below already receives `history`; the
    // router was the only path treating every web message as turn one). FRIDAY's wire shape is
    // {role, text} — mapped to the {role, content} the shared loop takes.
    const priorTurns = (history ?? [])
      .filter((h: { role: string; text: string }): h is { role: "user" | "assistant"; text: string } => h.role === "user" || h.role === "assistant")
      .map((h: { role: "user" | "assistant"; text: string }) => ({ role: h.role, content: h.text }))
      .slice(-10);
    // The conversation's project, so "this project" resolves in the router (dispatch_task + its
    // prompt) instead of it asking "which project?" — CLARA's relayed asks always carry one.
    const proj = projectId ? await store.projects.get(projectId).catch(() => null) : null;
    const routed = await runIntent(message, {
      principal: requestOrigin === "clara" ? "clara" : "owner", source: "chat", history: priorTurns, onToken,
      project: proj ? { id: proj.id, name: proj.name } : undefined, images,
    });
    // An image only ever reaches the router — the planner below is text-only — so its answer stands.
    // The planner is also what writes the conversation to store.messages, so an image turn records
    // both sides here, or it would vanish from the thread on reload and from recall.
    // A failed router is not an answer: never record its error text as FRIDAY's reply in the thread
    // or recall (the caller still gets the failure below).
    let historyError: string | undefined;
    if (images.length && !routed.failed) {
      const said = `${message}${message ? " " : ""}[${images.length} image${images.length === 1 ? "" : "s"} attached]`;
      const { persistImageTurn } = await import("@/lib/friday/imageTurn");
      const saved = await persistImageTurn(
        (row) => store.messages.append(row as never),
        { id: newId(), channel, role: "user", text: said, ts: nowISO(), projectId },
        { id: newId(), channel, role: "friday", text: routed.reply, ts: nowISO(), projectId },
      );
      if (!saved.ok) {
        historyError = saved.error;
        await logEvent("chat.image_turn_unsaved", { channel, error: saved.error }, { level: "warn", projectId }).catch(() => {});
      }
    }
    if (routed.calls.length || routed.clarifying || routed.failed || images.length) {
      // A failed router must not fall through silently — the planner would answer as if nothing
      // were wrong. `failed` also travels to the caller: CLARA used to read the 200 as a delivered
      // hand-off, so an ask that FRIDAY never actually took was recorded as done (2026-09-28).
      return { reply: routed.reply, intent: "chat", tasks: [], runs: [], approvals: [], ...(routed.failed ? { failed: true } : {}), ...(historyError ? { historySaved: false, historyError } : {}) };
    }
    return await orchestrate(message, { projectId, channel, from, history, requestOrigin }) as unknown as Record<string, unknown>;
  };

  // P2.7 streaming mode (?stream=1): NDJSON — {t:"typing"}, router {t:"token",text} deltas, one
  // authoritative {t:"msg",...} (the same payload JSON mode returns), {t:"done"}. Same protocol
  // family as /api/room. The planner path emits no tokens; the client holds "typing" until msg.
  if (new URL(req.url).searchParams.get("stream") === "1") {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const frame = (o: unknown) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* client gone */ } };
        frame({ t: "typing" });
        try {
          const out = await respond((text) => frame({ t: "token", text }));
          frame({ t: "msg", ...out });
        } catch (e) {
          frame({ t: "msg", reply: "Something broke mid-reply — nothing was changed. Try again.", error: String(e).slice(0, 200) });
        }
        frame({ t: "done" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  try {
    const out = await respond();
    // A turn FRIDAY could not plan is a failure to the caller, not a reply: 503 lets CLARA's bridge
    // report "nothing ran" instead of recording a hand-off that no task will ever close.
    return NextResponse.json(out, (out as { failed?: boolean }).failed ? { status: 503 } : undefined);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
