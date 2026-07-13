import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { makeSecretKey, verifyAccessToken } from './jwt.js';

const SECRET = 'test-nextauth-secret-16ch';
const key = makeSecretKey(SECRET);

function sign(claims: Record<string, unknown>, expSec = '1h') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expSec)
    .sign(key);
}

const CLAIMS = {
  sub: 'u-1',
  email: 'ops@fx.local',
  role: 'operator',
  stepUp2FAAt: null,
};

describe('BE-030 jwt — access-token verification', () => {
  it('verifies a well-formed HS256 token', async () => {
    const token = await sign(CLAIMS);
    const result = await verifyAccessToken(token, key);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('u-1');
      expect(result.claims.role).toBe('operator');
      expect(result.exp).toBeGreaterThan(0);
    }
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await sign(CLAIMS);
    const result = await verifyAccessToken(token, makeSecretKey('another-secret-16-chars'));
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports expiry distinctly', async () => {
    const token = await sign(CLAIMS, '-1s');
    const result = await verifyAccessToken(token, key);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a valid signature with malformed claims', async () => {
    const token = await sign({ sub: 'u-1' }); // missing email/role
    const result = await verifyAccessToken(token, key);
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});
