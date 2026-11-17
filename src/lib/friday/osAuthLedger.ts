// OS auth-failure ledger, fed by EVERY native OS call (osClient wraps callTool) and read by the
// liveness alarm (osLiveness.ts). Kept free of imports so osClient.ts can use it without a cycle.

/** True when the error is an OS session/auth failure (the session needs repair, not a retry). */
export function isOsAuthError(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /refresh_token_already_used|refresh_token_not_found|invalid_grant|invalid refresh token/i.test(s)
    || /Orion token refresh 4\d\d/i.test(s)
    || /Orion not connected|Orion Supabase project not configured/i.test(s)
    || /\b401\b.*(unauthori[sz]ed|jwt)|jwt expired|invalid jwt/i.test(s);
}

interface AuthFailureState { firstAt: number; lastAt: number; count: number; lastError: string }
let authFailure: AuthFailureState | null = null;

/** Record the outcome of ANY OS call. Success clears the streak; non-auth errors leave it alone. */
export function noteOsCallOutcome(err: unknown | null): void {
  if (err == null) { authFailure = null; return; }
  if (!isOsAuthError(err)) return;
  const now = Date.now();
  const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
  authFailure = authFailure
    ? { ...authFailure, lastAt: now, count: authFailure.count + 1, lastError: msg }
    : { firstAt: now, lastAt: now, count: 1, lastError: msg };
}

/** Current consecutive OS auth-failure streak, or null when the last OS call succeeded. */
export function osAuthFailureState(): Readonly<AuthFailureState> | null {
  return authFailure;
}

/** Test hook. */
export function _resetOsAuthLedger(): void {
  authFailure = null;
}
