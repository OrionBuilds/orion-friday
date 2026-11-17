// Conversational owner SMS — FRIDAY texting back like a person, not a planner.
//
// The inbound Twilio route keeps its command layers (resume/sweep/handoff/approvals) at ABSOLUTE
// priority, and the planner keeps handling anything work-shaped (tasks, intake, away/back, actions).
// This module covers the remaining case: the owner texts something that's just conversation ("how are we
// looking?", "nice work today") and deserves a real reply in FRIDAY's voice, grounded in what's
// actually happening right now — instead of the planner's JSON-shaped one-liner or a "rephrase that"
// complaint. Mirrors CLARA's owner-SMS pattern (instant TwiML ACK in the route; this composes the
// async reply that goes out as a separate outbound SMS).

import { store, newId, nowISO } from "@/lib/persistence/store";
import { complete } from "@/lib/friday/engines";
import { FRIDAY_CORE, fridayVoice, OWNER_FIRST } from "@/lib/friday/persona";
import { recallBlock } from "@/lib/friday/memory";
import { memoryForMessage } from "@/lib/friday/vaultMemory";

// Compact live status from CHEAP store reads only (local JSON collections + the log tail).
// Deliberately NO engine probes, no network calls, no deep health — this runs on every casual text
// and must never make a two-line reply slow or expensive.
async function liveStatusBlock(): Promise<string> {
  const [pending, active, logs] = await Promise.all([
    store.approvals.find((a) => a.status === "pending"),
    store.runs.find((r) => r.status === "running" || r.status === "queued"),
    store.logs.tail(30),
  ]);
  const lines: string[] = [
    pending.length
      ? `- Pending approvals (${pending.length}): ${pending.map((a) => a.action).join("; ").slice(0, 400)} (they decide by replying to the approval email or telling CLARA — never mention codes)`
      : "- Pending approvals: none",
    `- Active agent runs: ${active.length}`,
  ];
  // Last 2-3 notable log events — prefer warn/error; fall back to whatever happened most recently.
  const notable = logs.filter((l) => l.level !== "info");
  const recent = (notable.length ? notable : logs).slice(-3);
  if (recent.length) {
    lines.push(`- Recent events: ${recent.map((l) => l.event + (l.level !== "info" ? ` [${l.level}]` : "")).join(", ")}`);
  }
  return lines.join("\n");
}

// Compose FRIDAY's conversational reply to the owner. Returns "" on an empty completion so the
// caller can fall back (the route never sends a blank SMS). Errors propagate — the route swallows
// them into its own fallback; the webhook itself already ACKed Twilio long before this runs.
//
// channel "sms" (default) keeps the original texting behavior byte-for-byte. channel "voice" is the
// phone-call variant: spoken prose, ~2 sentences, no codes/URLs read aloud — and a much shorter LLM
// timeout, because the voice webhook races this against Twilio's ~15s deadline and will abandon it.
//
// `history` — the recent prior turns on this channel, same shape and same source (store.messages)
// orchestrate() itself reconstructs. Without it this function previously saw ONLY the single current
// message, with no memory of anything said a text or two earlier — the direct cause of the owner asking a
// follow-up and getting a reply that made clear FRIDAY had no idea what they meant.
export async function composeOwnerChatReply(
  text: string,
  opts?: { channel?: "sms" | "voice"; history?: { role: string; text: string }[] },
): Promise<string> {
  const channel = opts?.channel ?? "sms";
  const status = await liveStatusBlock();
  const history = (opts?.history ?? []).slice(-10).map((h) => `${h.role === "user" ? OWNER_FIRST : "FRIDAY"}: ${h.text}`).join("\n");
  // Institutional memory (same recall FRIDAY's planner leans on) — grounds the reply in past
  // deliverables/decisions/notes when the topic touches something she has actually done. Best-effort:
  // an unreachable embedding backend must never turn a two-line reply into a stalled one.
  const memory = (await memoryForMessage(text).catch(() => "")) + (await recallBlock(text, { limit: 4 }).catch(() => ""));
  const situation = channel === "voice"
    ? `You are on a PHONE CALL with ${OWNER_FIRST} — your reply is read aloud by text-to-speech. This is conversation, not a work directive — just talk to them.`
    : `You are texting with ${OWNER_FIRST} over SMS. This is casual conversation, not a work directive — just talk to them.`;
  const rules = channel === "voice"
    ? `Rules:
- Spoken prose only: no markdown, no bullet points, nothing that only makes sense on a screen.
- At most two short sentences.
- Never read out approval codes, IDs, or URLs unless they explicitly ask — say it's in the queue and that they can say "approve one" to release it.`
    : `Rules:
- Plain text only: no markdown, no bullet points, no headings.
- At most ~300 characters (about two SMS segments). One short paragraph.
- Don't enumerate the approval queue yourself — the exact codes are appended after your reply automatically.`;
  const system = `${FRIDAY_CORE}

${fridayVoice()}

${situation}

Live status right now (real data — draw on it when relevant, ignore it when it isn't):
${status}${memory}

${rules}`;

  const reply = (await complete({
    system,
    prompt: `${history ? `Recent conversation:\n${history}\n\n` : ""}${OWNER_FIRST}'s ${channel === "voice" ? "spoken words" : "text"}:\n${text}`,
    timeoutMs: channel === "voice" ? 8_000 : 60_000,
  })).trim();
  if (reply) {
    // Keep the stored thread truthful: this is the line the owner actually receives. (orchestrate()
    // already appended the planner's draft reply, but that draft was superseded by this one — future
    // multi-turn context should reflect what was really sent.)
    await store.messages.append({ id: newId(), channel, role: "friday", text: reply, ts: nowISO() }).catch(() => {});
  }
  return reply.slice(0, 600);
}
