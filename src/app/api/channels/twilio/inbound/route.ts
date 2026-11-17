import { orchestrate } from "@/lib/friday/orchestrator";
import { twiml, twilioSignatureValid, twilioPublicUrl, sendSMS as rawSendSMS, markOwnerInbound } from "@/lib/friday/channels";
import { resolveSender, handleClientMessage } from "@/lib/friday/clientChannel";
import { handleOwnerApproval, pendingApprovalsBlock, tryResolveApprovalLookup } from "@/lib/friday/ownerCommands";
import { notifyOwner } from "@/lib/friday/notify";
import { logEvent, store } from "@/lib/persistence/store";
import { firstName, OWNER_FIRST, AGENCY } from "@/lib/friday/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Twilio inbound SMS webhook. Twilio POSTs form-encoded { From, Body, ... }.
// FRIDAY plans/acts on the text and replies with TwiML (shown as an SMS back).
//
// Point your Twilio number's "A MESSAGE COMES IN" webhook at:
//   https://<your-tunnel>/api/channels/twilio/inbound   (POST)
// Expose localhost with a tunnel (cloudflared/ngrok) since Twilio needs a public URL.
export async function POST(req: Request) {
  const params: Record<string, string> = {};
  try {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch {
    return xml(twiml("Sorry — I couldn't read that message."));
  }
  // Public endpoint (Access-bypassed) — reject anything that isn't a genuine Twilio request.
  if (!twilioSignatureValid(req, twilioPublicUrl(req), params)) {
    return new Response("invalid Twilio signature", { status: 403 });
  }
  const body = (params.Body ?? "").trim();
  const from = params.From ?? "";
  if (!body) return xml(twiml("Say something and I'll get on it."));

  const sender = await resolveSender(from);
  // Owner gate (channels.ts): FRIDAY may only text the owner in REPLY to a text they just sent. Stamp
  // the inbound so the replies below clear the gate, and route every reply through `inboundReply`.
  if (sender.kind === "owner") await markOwnerInbound(from);
  const sendSMS = (to: string, body: string) => rawSendSMS(to, body, { inboundReply: { from } });

  // Unknown number → instant static reply (no LLM, well within Twilio's timeout).
  if (sender.kind === "unknown") {
    return xml(twiml(`Hi — this is FRIDAY, the assistant for ${AGENCY}. I don't recognize this number yet. If you're a client, let your account manager know and we'll get you connected.`));
  }

  // Owner/client → the planner can take longer than Twilio's ~15s webhook timeout (especially
  // on a cold server/model). So ACK Twilio instantly with an empty TwiML and deliver FRIDAY's
  // reply as a SEPARATE outbound SMS once it's ready — the reply never races the timeout.
  void (async () => {
    try {
      let reply: string;
      if (sender.kind === "client") {
        // Master gate: FRIDAY no longer replies to clients (CLARA-only). Notify the owner
        // that the client texted, but send nothing back.
        const { clientCommsEnabled } = await import("@/lib/friday/clientComms");
        reply = clientCommsEnabled() ? await handleClientMessage(sender.client, body, "sms") : "";
        await notifyOwner({ kind: "client.msg", text: `📩 ${sender.client.name} texted: "${body.slice(0, 200)}"`, dedupeKey: `clientmsg:${from}:${body.slice(0, 40)}` }).catch(() => {});
      } else {
        // Owner: "resume sends" clears the outbound global-breaker pause.
        if (/^\s*(resume|unpause)\s+(sends?|outbound)\s*$/i.test(body)) {
          const { clearOutboundPause } = await import("@/lib/friday/outbound");
          await clearOutboundPause();
          await sendSMS(from, "Outbound resumed — the pause is cleared.");
          return;
        }
        // Owner: "sweep planning" deletes stale planning cards (backed up first — boardHygiene.ts).
        if (/^\s*sweep\s+planning\s*$/i.test(body)) {
          const { sweepPlanning } = await import("@/lib/friday/boardHygiene");
          await sendSMS(from, (await sweepPlanning()).slice(0, 1200));
          return;
        }
        // Owner: "resume <client>" / "resume all" hands a client on manual handoff back to FRIDAY.
        // Checked first (before approvals) so it never collides with the "release" approval verb.
        const { tryResolveHandoffCommand } = await import("@/lib/friday/escalations");
        const resumed = await tryResolveHandoffCommand(body);
        if (resumed !== null) { await sendSMS(from, resumed); return; }
        // Owner: "stop/turn off meeting follow ups" — the durable, remote off-switch for the
        // recurring meeting-recap-email feature (2026-08-20 incident: the owner asked for this over SMS
        // and there was nowhere for the instruction to land). Symmetric "on"/"resume" flips it back.
        {
          const stopMatch = /^\s*(?:stop|turn off|no more|don'?t|do not)\s+(?:send(?:ing)?\s+)?(?:the\s+)?meeting[\s-]?follow[\s-]?ups?/i.test(body);
          const resumeMatch = /^\s*(?:turn on|resume|start(?:ing)?\s+(?:up\s+)?again)\s+(?:send(?:ing)?\s+)?(?:the\s+)?meeting[\s-]?follow[\s-]?ups?/i.test(body);
          if (stopMatch || resumeMatch) {
            const { setDial } = await import("@/lib/friday/dials");
            const r = await setDial("meeting_followups", stopMatch ? "off" : "on", "owner (sms)");
            await sendSMS(from, r.message);
            return;
          }
        }
        // Owner: "what is #D297 about" / "what were you referring to" — answered straight from
        // store.approvals, zero LLM calls. Checked before the approval verbs and the planner so
        // this class of question never depends on claude/LM Studio being healthy.
        const lookup = await tryResolveApprovalLookup(body);
        if (lookup !== null) { await sendSMS(from, lookup.slice(0, 1500)); return; }
        // Owner: an approval command ("approve #3F2A" / "reject all" / "ship it") clears the gate
        // from anywhere — no web app needed. Otherwise fall through to the planner.
        const approval = await handleOwnerApproval(body);
        if (approval !== null) {
          reply = approval + (await pendingApprovalsBlock());
        } else {
          // The intent router runs BEFORE the planner. It covers the direct questions the planner
          // had no good answer for ("is anything broken", "what's in flight", "ship the site"), and
          // its only way to affect anything is to call a tool — so it cannot narrate work it did not
          // do, which the conversational fallback below can.
          //
          // It deliberately does NOT claim the turn for ordinary conversation: `clarifying` is set
          // only for a question or a refusal. Anything else falls through to the planner exactly as
          // before, so work-shaped requests keep their existing path.
          const { runIntent } = await import("@/lib/friday/intent");
          const routed = await runIntent(body, { principal: "owner", source: "sms" });
          if (routed.calls.length || routed.clarifying) {
            reply = routed.reply + (await pendingApprovalsBlock());
            if (reply.trim()) {
              const sent = await sendSMS(from, reply.slice(0, 1500));
              if (!sent.ok) {
                await logEvent("client.reply_send_failed", { to: from, error: sent.error?.slice(0, 200) }, { level: "warn" }).catch(() => {});
              }
            }
            return;
          }
          // A router that FAILED is not a reason to fall through silently — the planner would answer
          // as if nothing were wrong. Say so, and stop.
          if (routed.failed) {
            await sendSMS(from, routed.reply).catch(() => {});
            return;
          }
          // Snapshot the prior turns ONCE, before orchestrate() appends this turn's own messages —
          // both orchestrate() and (for the pureChat case below) composeOwnerChatReply need the SAME
          // pre-turn history, and fetching it after orchestrate() runs would pick up its own
          // just-appended (and possibly discarded, see below) entries instead of real prior context.
          const priorMsgs = await store.messages.tail(12, (m) => m.channel === "sms");
          const history = priorMsgs.map((m) => ({ role: m.role === "user" ? "user" : "friday", text: m.text }));
          const result = await orchestrate(body, { channel: "sms", from, history });
          // Pure conversation — the planner said "chat" and created/ran nothing — gets a REAL
          // conversational reply in FRIDAY's voice with live status context (ownerChat.ts),
          // mirroring CLARA's owner-SMS behavior, instead of the planner's JSON-shaped one-liner
          // (or its "rephrase that" complaint when the plan didn't parse). Anything work-shaped
          // (tasks, actions, intake, away/back) keeps the planner reply exactly as before.
          const pureChat = result.intent === "chat" && !result.project && !result.tasks.length && !result.runs.length && !result.approvals.length;
          if (pureChat) {
            const { composeOwnerChatReply } = await import("@/lib/friday/ownerChat");
            reply = (await composeOwnerChatReply(body, { history }).catch(() => "")) || result.reply || "On it.";
          } else {
            reply = result.reply || "On it.";
            const bits: string[] = [];
            if (result.project) bits.push(`project: ${result.project.name}`);
            if (result.tasks.length) bits.push(`${result.tasks.length} tasks`);
            if (bits.length) reply += `\n(${bits.join(" · ")})`;
          }
          reply += await pendingApprovalsBlock(); // numbered list so risky work can be released by text
        }
      }
      // An empty reply means "stay quiet" (e.g. an active human-handoff on this client) — never send a
      // blank SMS. This is direct sendSMS to the number that texted us, deliberately BYPASSING the
      // notifyOwner ladder: a reply to the owner's own inbound text is conversation, not a
      // notification — it must never be deduped, batched into a digest, or deferred by quiet hours.
      if (reply.trim()) {
        // sendSMS resolves {ok:false} on a Twilio 4xx/5xx rather than throwing, so ignoring the
        // result made a rejected send indistinguishable from a delivered one. Log the failure.
        const sent = await sendSMS(from, reply.slice(0, 1500));
        if (!sent.ok) {
          await logEvent("client.reply_send_failed", { to: from, error: sent.error?.slice(0, 200) }, { level: "warn" }).catch(() => {});
        }
      }
    } catch (e) {
      // This branch is the only reason anyone ever learned about the 90s claude-CLI timeout for the
      // OWNER's own texts — keep the raw error visible to them, still. A CLIENT must never see one
      // (2026-09-17 client incident: "I hit a snag: TimeoutError: The operation was
      // aborted due to timeout" went straight to a client's phone). Record it either way, page the
      // owner with the client's original text so the ask isn't silently lost, and give the client a
      // warm, content-free reply instead.
      await logEvent("client.reply_failed", { to: from, error: String(e).slice(0, 300), sender: sender.kind }, { level: "error" }).catch(() => {});
      if (sender.kind === "client") {
        await notifyOwner({
          kind: "client.reply_failed",
          priority: "critical",
          text: `⚠️ FRIDAY hit an error replying to ${sender.client.name}'s text: "${body.slice(0, 160)}" — ${String(e).slice(0, 160)}. Nothing was sent to them; please follow up.`,
          dedupeKey: `replyfail:${from}:${body.slice(0, 40)}`,
        }).catch(() => {});
        await sendSMS(from, `Hey ${firstName(sender.client.name)} — I hit a snag on my end. I've flagged it with ${OWNER_FIRST} and we'll get right back to you.`).catch(() => {});
      } else {
        await sendSMS(from, `I hit a snag: ${String(e).slice(0, 200)}`).catch(() => {});
      }
    }
  })();

  // Empty TwiML = valid instant response; FRIDAY's real answer arrives via the outbound SMS above.
  return xml('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
}

function xml(s: string): Response {
  return new Response(s, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}
