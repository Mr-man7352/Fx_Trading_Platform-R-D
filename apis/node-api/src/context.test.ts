import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

/**
 * BE-030 — the JWT verification middleware, exercised through the real app with
 * no DB (so the suspension lookup is skipped and auth routes aren't mounted).
 */
const SECRET = 'test-nextauth-secret-16ch';
const INTERNAL = 'test-internal-token-16ch';

function testEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: INTERNAL,
    NEXTAUTH_SECRET: SECRET,
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
}

function sign(claims: Record<string, unknown>, exp = '1h') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(SECRET));
}

describe('BE-030 — JWT auth middleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(testEnv());
    app.get('/v1/test/whoami', async (req) => ({
      role: req.context.role,
      userId: req.context.user?.id ?? null,
      stepUp2FAAt: req.context.stepUp2FAAt,
    }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('populates context from a valid Bearer JWT', async () => {
    const token = await sign({
      sub: 'u-1',
      email: 'ops@fx.local',
      role: 'operator',
      stepUp2FAAt: null,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'operator', userId: 'u-1' });
  });

  it('rejects a tampered/invalid token with 401 INVALID_TOKEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('reports expiry as 401 INVALID_TOKEN', async () => {
    const token = await sign(
      { sub: 'u-1', email: 'ops@fx.local', role: 'operator', stepUp2FAAt: null },
      '-1s',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('still accepts the internal service token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: { 'x-internal-token': INTERNAL },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'internal', userId: 'internal' });
  });

  it('401s an unauthenticated request to a protected route', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/test/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});
