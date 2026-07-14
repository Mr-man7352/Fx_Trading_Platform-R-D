/** BE-121 — canary one-tap confirm/reject on pending live canary intents. */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { PrismaClient } from '../db.js';
import { loadEnv } from '../env.js';

const TOKEN = 'test-internal-token-16ch';
const auth = { 'x-internal-token': TOKEN };

const INTENT_ID = 'd4d4d4d4-4444-4d5d-8e6e-f7f7f7f7f7f7';

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'live',
    INTERNAL_API_TOKEN: TOKEN,
    NEXTAUTH_SECRET: 'test-nextauth-secret-16ch',
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CANARY_CONFIRM_TTL_MIN: '15',
    ...overrides,
  });
}

interface IntentRow extends Record<string, unknown> {
  id: string;
  status: string;
}

function fakePrismaWithIntent(overrides: Partial<IntentRow> = {}) {
  const intents: IntentRow[] = [
    {
      id: INTENT_ID,
      signalId: 'sig-1',
      instrument: 'EUR_USD',
      side: 'long',
      units: '1000',
      status: 'pending',
      reasonCode: null,
      createdAt: new Date(), // fresh — within the TTL
      decidedAt: null,
      riskGate: {
        verdict: 'approved',
        canary: { confirmRequired: true, unitsRequested: 10_000, unitsClamped: 1_000 },
      },
      ...overrides,
    },
  ];
  const audits: Record<string, unknown>[] = [];
  const prisma = {
    $disconnect: async () => {},
    tradeIntent: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        intents.find((i) => i.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = intents.find((i) => i.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, intents, audits };
}

function fakeExecutionQueue() {
  const jobs: Array<{ name: string; data: unknown }> = [];
  return {
    jobs,
    queue: {
      add: async (name: string, data: unknown) => {
        jobs.push({ name, data });
        return {};
      },
    } as never,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('BE-121 — POST /api/trades/intents/:id/confirm', () => {
  it('503 when the execution queue is not wired (never a silent no-op)', async () => {
    const { prisma } = fakePrismaWithIntent();
    app = await buildApp(testEnv(), { prisma });
    const res = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EXECUTION_QUEUE_UNAVAILABLE');
  });

  it('confirms a fresh pending canary intent: approved + execution job enqueued + audited', async () => {
    const { prisma, intents, audits } = fakePrismaWithIntent();
    const exec = fakeExecutionQueue();
    app = await buildApp(testEnv(), { prisma, trades: { executionQueue: exec.queue } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ intentId: INTENT_ID, status: 'approved' });
    expect(intents[0]).toMatchObject({ status: 'approved' });
    expect(intents[0]?.decidedAt).toBeInstanceOf(Date);
    expect(exec.jobs).toEqual([{ name: 'execute-intent', data: { intentId: INTENT_ID } }]);
    expect(
      audits.some((a) => (a.details as { action: string }).action === 'canary_confirmed'),
    ).toBe(true);
  });

  it('410 Gone + cancellation once the TTL has elapsed (market moved on)', async () => {
    const { prisma, intents } = fakePrismaWithIntent({
      createdAt: new Date(Date.now() - 16 * 60_000), // 16 min > 15 min TTL
    });
    const exec = fakeExecutionQueue();
    app = await buildApp(testEnv(), { prisma, trades: { executionQueue: exec.queue } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('CANARY_CONFIRM_EXPIRED');
    expect(intents[0]).toMatchObject({
      status: 'cancelled',
      reasonCode: 'CANARY_CONFIRM_EXPIRED',
    });
    expect(exec.jobs).toHaveLength(0); // expired confirm NEVER executes
  });

  it('409 for a pending intent that was NOT parked by the canary ramp (no backdoor)', async () => {
    const { prisma } = fakePrismaWithIntent({ riskGate: { verdict: 'approved' } });
    const exec = fakeExecutionQueue();
    app = await buildApp(testEnv(), { prisma, trades: { executionQueue: exec.queue } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/confirm`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_A_CANARY_INTENT');
    expect(exec.jobs).toHaveLength(0);
  });

  it('409 for an already-decided intent; 404 for an unknown id', async () => {
    const { prisma } = fakePrismaWithIntent({ status: 'approved' });
    const exec = fakeExecutionQueue();
    app = await buildApp(testEnv(), { prisma, trades: { executionQueue: exec.queue } });

    const decided = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/confirm`,
      headers: auth,
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error.code).toBe('INTENT_NOT_PENDING');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/trades/intents/00000000-0000-4000-8000-000000000000/confirm',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('BE-121 — POST /api/trades/intents/:id/reject', () => {
  it('rejects a pending canary intent without touching the execution queue', async () => {
    const { prisma, intents, audits } = fakePrismaWithIntent();
    const exec = fakeExecutionQueue();
    app = await buildApp(testEnv(), { prisma, trades: { executionQueue: exec.queue } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/trades/intents/${INTENT_ID}/reject`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'rejected', reasonCode: 'CANARY_REJECTED' });
    expect(intents[0]).toMatchObject({ status: 'rejected', reasonCode: 'CANARY_REJECTED' });
    expect(exec.jobs).toHaveLength(0);
    expect(
      audits.some((a) => (a.details as { action: string }).action === 'canary_rejected'),
    ).toBe(true);
  });
});
