// The one rollback switch for FRIDAY's retired own-channels (Twilio SMS/voice, Gmail/Google). In the
// one-source-of-truth move (2026-10) client contact belongs to Clara and the OS, so these are OFF unless
// FRIDAY_LEGACY_CHANNELS=on. Dependency-free on purpose: channels.ts, google/auth.ts and the scheduler all
// import it, and it must never pull the store or the engines in with it.
export function legacyChannelsOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FRIDAY_LEGACY_CHANNELS ?? "").trim().toLowerCase() === "on";
}
