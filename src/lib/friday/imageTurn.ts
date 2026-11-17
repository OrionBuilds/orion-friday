// Recording an image turn in FRIDAY's chat history (/api/friday/chat). The router answers image
// turns itself — the planner, which normally writes store.messages, never sees them — so the route
// writes both sides. The message stream is append-only (no delete), so consistency is by ordering:
// the request is written first and the reply only if it landed; a reply that fails to write gets one
// retry. Any failure is returned, never swallowed, so the route can log it and tell the caller the
// thread didn't keep the turn.

export interface TurnRow { id: string; channel: string; role: "user" | "friday"; text: string; ts: string; projectId?: string }

export async function persistImageTurn(
  append: (row: TurnRow) => Promise<unknown>,
  user: TurnRow,
  reply: TurnRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try { await append(user); }
  catch (e) { return { ok: false, error: `request not saved (${String(e).slice(0, 160)}); reply not written so the thread stays consistent` }; }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await append(reply); return { ok: true }; }
    catch (e) { lastErr = e; }
  }
  return { ok: false, error: `reply not saved after the request was (${String(lastErr).slice(0, 160)})` };
}
