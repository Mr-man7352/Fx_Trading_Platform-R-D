import { describe, expect, it } from 'vitest';
import { createToken, hashToken, isExpired, tokenHashMatches } from './tokens.js';

describe('BE-034 tokens — email verify / password reset', () => {
  it('stores only the hash and matches the raw token', () => {
    const t = createToken(60);
    expect(t.token).not.toEqual(t.tokenHash);
    expect(t.tokenHash).toEqual(hashToken(t.token));
    expect(tokenHashMatches(t.token, t.tokenHash)).toBe(true);
    expect(tokenHashMatches('wrong', t.tokenHash)).toBe(false);
  });

  it('sets expiry from the TTL and detects expiry', () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const t = createToken(60, now);
    expect(t.expiresAt.getTime()).toBe(now.getTime() + 3_600_000);
    expect(isExpired(t.expiresAt, now)).toBe(false);
    expect(isExpired(t.expiresAt, new Date(now.getTime() + 3_600_001))).toBe(true);
  });

  it('produces high-entropy, unique tokens', () => {
    const a = createToken(60);
    const b = createToken(60);
    expect(a.token).not.toEqual(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
  });
});
