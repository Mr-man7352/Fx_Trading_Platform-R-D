import { type FXSession, FXSessionSchema, STEP_UP_MAX_AGE_MS } from '@fx/types';

export type { FXSession };
export { STEP_UP_MAX_AGE_MS };

/** Parse an unknown session object (e.g. from next-auth `auth()`) into a typed FXSession. */
export function parseFXSession(session: unknown): FXSession | null {
  const result = FXSessionSchema.safeParse(session);
  return result.success ? result.data : null;
}

/**
 * FE-006 — step-up freshness: true when a sensitive action needs a fresh TOTP check.
 * Stale when `stepUp2FAAt` is null or older than 15 minutes.
 */
export function needsStepUp(session: FXSession | null, now: Date = new Date()): boolean {
  if (!session?.stepUp2FAAt) return true;
  return now.getTime() - new Date(session.stepUp2FAAt).getTime() > STEP_UP_MAX_AGE_MS;
}

/**
 * Server-side guard. Pass next-auth's `auth()` result; throws if unauthenticated.
 * Wired to real NextAuth config in Phase 5 (BE-030, FE-030).
 */
export function requireAuth(session: unknown): FXSession {
  const parsed = parseFXSession(session);
  if (!parsed) {
    throw new Error('UNAUTHENTICATED');
  }
  return parsed;
}
