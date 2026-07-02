import { describe, expect, it } from 'vitest';
import { needsStepUp, parseFXSession, requireAuth } from './index.js';

const validSession = {
  user: { id: 'u1', email: 'op@example.com' },
  stepUp2FAAt: new Date().toISOString(),
  expires: new Date(Date.now() + 3600_000).toISOString(),
};

describe('@fx/auth-client', () => {
  it('parses a valid FXSession', () => {
    expect(parseFXSession(validSession)?.user.id).toBe('u1');
  });

  it('returns null for junk sessions', () => {
    expect(parseFXSession({ user: {} })).toBeNull();
    expect(parseFXSession(null)).toBeNull();
  });

  it('needsStepUp is false when fresh, true when stale (>15 min)', () => {
    const session = parseFXSession(validSession);
    expect(needsStepUp(session)).toBe(false);
    const stale = parseFXSession({
      ...validSession,
      stepUp2FAAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    });
    expect(needsStepUp(stale)).toBe(true);
    expect(needsStepUp(parseFXSession({ ...validSession, stepUp2FAAt: null }))).toBe(true);
  });

  it('requireAuth throws when unauthenticated', () => {
    expect(() => requireAuth(null)).toThrow('UNAUTHENTICATED');
    expect(requireAuth(validSession).user.email).toBe('op@example.com');
  });
});
