/** BE-132 — /gdpr/* routes: export link lifecycle + erasure confirmation. */

import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { EmailMessage } from '../auth/email.js';
import type { PrismaClient } from '../db.js';
import { loadEnv } from '../env.js';

const SECRET = 'test-nextauth-secret-16ch';
const USER_ID = 'e5e5e5e5-5555-4e6e-8f7f-a8a8a8a8a8a8';

function testEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: 'test-internal-token-16ch',
    NEXTAUTH_SECRET: SECRET,
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    APP_BASE_URL: 'https://fx.example',
  });
}

function sign(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
}

async function operatorAuth(stepUpFresh = false) {
  const token = await sign({
    sub: USER_ID,
    email: 'ops@fx.local',
    role: 'operator',
    stepUp2FAAt: stepUpFresh ? new Date().toISOString() : null,
  });
  return { authorization: `Bearer ${token}` };
}

function fakePrisma() {
  const exportsByToken = new Map<string, Record<string, unknown>>();
  const audits: Record<string, unknown>[] = [];
  const user: Record<string, unknown> = {
    id: USER_ID,
    email: 'ops@fx.local',
    name: 'Operator',
    image: null,
    googleId: null,
    passwordHash: 'hash',
    role: 'operator',
    status: 'active',
    emailVerifiedAt: null,
    totpSecret: null,
    twoFactorEnabledAt: null,
    erasedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const prisma = {
    $disconnect: async () => {},
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === USER_ID ? user : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(user, data);
        return user;
      },
    },
    trade: { findMany: async () => [], count: async () => 0 },
    brokerCredential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    recoveryCode: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    emailVerificationToken: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    inviteCode: { findMany: async () => [] },
    inviteRedemption: { findMany: async () => [] },
    auditLog: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
    gdprExport: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'a7a7a7a7-7777-4a8a-8b9b-c0c0c0c0c0c0', downloadedAt: null, ...data };
        exportsByToken.set(String(data.token), row);
        return row;
      },
      findUnique: async ({ where }: { where: { token: string } }) =>
        exportsByToken.get(where.token) ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => data,
      delete: async ({ where }: { where: { id: string } }) => {
        for (const [token, row] of exportsByToken) {
          if (row.id === where.id) exportsByToken.delete(token);
        }
        return {};
      },
      deleteMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
  return { prisma, exportsByToken, audits, user };
}

function fakeEmail() {
  const sent: EmailMessage[] = [];
  return { sent, send: async (msg: EmailMessage) => void sent.push(msg) };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('BE-132 — POST /gdpr/export + GET /gdpr/exports/:token', () => {
  it('builds the ZIP, stores it behind a 7-day token, and emails the link', async () => {
    const { prisma, exportsByToken, audits } = fakePrisma();
    const email = fakeEmail();
    app = await buildApp(testEnv(), { prisma, gdpr: { email } });

    const res = await app.inject({
      method: 'POST',
      url: '/gdpr/export',
      headers: await operatorAuth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toContain('user.json');
    expect(body.downloadPath).toMatch(/^\/gdpr\/exports\/[0-9a-f]{64}$/);
    // ~7-day expiry.
    const ttlDays = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(6.9);
    expect(ttlDays).toBeLessThanOrEqual(7);
    // Emailed to the account address with the absolute link (AC).
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('ops@fx.local');
    expect(email.sent[0]?.text).toContain(`https://fx.example${body.downloadPath}`);
    expect(exportsByToken.size).toBe(1);
    expect(
      audits.some((a) => (a.details as { action: string }).action === 'gdpr_export_created'),
    ).toBe(true);

    // The capability link serves the ZIP without a session.
    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.rawPayload.readUInt32LE(0)).toBe(0x04034b50); // ZIP local header
  });

  it('401 without a user session; 404 unknown token; 410 + delete once expired', async () => {
    const { prisma, exportsByToken } = fakePrisma();
    const email = fakeEmail();
    app = await buildApp(testEnv(), { prisma, gdpr: { email } });

    const anon = await app.inject({ method: 'POST', url: '/gdpr/export' });
    expect(anon.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET',
      url: `/gdpr/exports/${'0'.repeat(64)}`,
    });
    expect(missing.statusCode).toBe(404);

    // Create then force-expire.
    const res = await app.inject({
      method: 'POST',
      url: '/gdpr/export',
      headers: await operatorAuth(),
    });
    const token = res.json().downloadPath.split('/').at(-1) as string;
    const row = exportsByToken.get(token) as { expiresAt: Date };
    row.expiresAt = new Date(Date.now() - 1000);
    const expired = await app.inject({ method: 'GET', url: `/gdpr/exports/${token}` });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('EXPORT_EXPIRED');
    expect(exportsByToken.has(token)).toBe(false); // row deleted, link dead forever
  });
});

describe('BE-132 — POST /gdpr/erasure', () => {
  it('requires fresh step-up 2FA (403 without it)', async () => {
    const { prisma } = fakePrisma();
    app = await buildApp(testEnv(), { prisma, gdpr: { email: fakeEmail() } });
    const res = await app.inject({
      method: 'POST',
      url: '/gdpr/erasure',
      headers: await operatorAuth(false),
      payload: { confirmEmail: 'ops@fx.local' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 when the confirmation email does not match verbatim', async () => {
    const { prisma } = fakePrisma();
    app = await buildApp(testEnv(), { prisma, gdpr: { email: fakeEmail() } });
    const res = await app.inject({
      method: 'POST',
      url: '/gdpr/erasure',
      headers: await operatorAuth(true),
      payload: { confirmEmail: 'OPS@fx.local' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CONFIRMATION_MISMATCH');
  });

  it('anonymises per the retention policy and audits the summary', async () => {
    const { prisma, audits, user } = fakePrisma();
    app = await buildApp(testEnv(), { prisma, gdpr: { email: fakeEmail() } });
    const res = await app.inject({
      method: 'POST',
      url: '/gdpr/erasure',
      headers: await operatorAuth(true),
      payload: { confirmEmail: 'ops@fx.local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().erased).toBe(true);
    expect(user.email).toBe(`erased+${USER_ID}@anonymised.invalid`);
    expect(user.status).toBe('suspended');
    expect(
      audits.some((a) => (a.details as { action: string }).action === 'gdpr_erasure_completed'),
    ).toBe(true);
  });
});
