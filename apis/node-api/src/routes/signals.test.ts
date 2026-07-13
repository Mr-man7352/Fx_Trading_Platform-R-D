/** BE-067 — GET /signals: agent-cycle summaries; 503 without a DB. */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { PrismaClient } from '../db.js';
import { loadEnv } from '../env.js';

const TOKEN = 'test-internal-token-16ch';
const auth = { 'x-internal-token': TOKEN };

function testEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: TOKEN,
    NEXTAUTH_SECRET: 'test-nextauth-secret-16ch',
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
}

function fakePrismaWithSignals() {
  return {
    $disconnect: async () => {},
    signal: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
        const rows = [
          {
            id: 'f6a7b8c9-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
            createdAt: new Date('2026-07-09T13:00:05Z'),
            barTs: new Date('2026-07-09T13:00:00Z'),
            instrument: 'EUR_USD',
            timeframe: 'H1',
            side: 'long',
            entryPrice: '1.0885',
            stopLoss: '1.0845',
            takeProfit: '1.0965',
            quantScore: 0.63,
            status: 'approved',
            agentRuns: [
              { agentRole: 'technical_analyst', costUsd: '0.001', modelDowngraded: false },
              { agentRole: 'pm', costUsd: '0.003', modelDowngraded: true },
            ],
            _count: { debate: 4 },
          },
        ];
        const filtered = rows.filter(
          (r) =>
            (!where.instrument || r.instrument === where.instrument) &&
            (!where.status || r.status === where.status),
        );
        return filtered.slice(0, take);
      },
    },
  } as unknown as PrismaClient;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('BE-067 — GET /signals', () => {
  it('503 without a DB client', async () => {
    app = await buildApp(testEnv());
    const res = await app.inject({ method: 'GET', url: '/signals', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DB_UNAVAILABLE');
  });

  it('returns recent candidates with the agent summary', async () => {
    app = await buildApp(testEnv(), { prisma: fakePrismaWithSignals() });
    const res = await app.inject({ method: 'GET', url: '/signals?limit=10', headers: auth });
    expect(res.statusCode).toBe(200);
    const { signals } = res.json();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      instrument: 'EUR_USD',
      side: 'long',
      probability: 0.63,
      status: 'approved',
      entryPrice: 1.0885,
      debateTurns: 4,
      agents: {
        llmCalls: 2,
        roles: ['pm', 'technical_analyst'],
        anyDowngraded: true,
      },
    });
    expect(signals[0].agents.costUsd).toBeCloseTo(0.004, 6);
  });

  it('filters by status', async () => {
    app = await buildApp(testEnv(), { prisma: fakePrismaWithSignals() });
    const res = await app.inject({ method: 'GET', url: '/signals?status=rejected', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().signals).toHaveLength(0);
  });
});
