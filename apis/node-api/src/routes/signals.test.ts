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

// ─── QN-062 / FE-060 — GET /signals/:id/replay ───────────────────────────────

const SIGNAL_ID = 'f6a7b8c9-0d1e-4f2a-8b3c-4d5e6f7a8b9c';
const MEM_1 = 'a1a1a1a1-1111-4a2a-8b3b-c4c4c4c4c4c4';
const MEM_GONE = 'b2b2b2b2-2222-4b3b-9c4c-d5d5d5d5d5d5';

function fakePrismaForReplay() {
  return {
    $disconnect: async () => {},
    signal: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== SIGNAL_ID) return null;
        return {
          id: SIGNAL_ID,
          createdAt: new Date('2026-07-09T13:00:05Z'),
          barTs: new Date('2026-07-09T13:00:00Z'),
          instrument: 'EUR_USD',
          timeframe: 'H1',
          side: 'long',
          entryPrice: '1.0885',
          stopLoss: '1.0845',
          takeProfit: '1.0965',
          quantScore: 0.63,
          metaProbability: null,
          status: 'approved',
          features: { rsi_14: 61.2, atr_14: 0.0021 },
          agentRuns: [
            {
              id: 'c3c3c3c3-3333-4c4c-8d5d-e6e6e6e6e6e6',
              agentRole: 'technical_analyst',
              provider: 'anthropic',
              model: 'model-snapshot-1',
              tier: 'standard',
              promptHash: 'hash-1',
              modelDowngraded: false,
              downgradeReason: null,
              failedOver: false,
              inputTokens: 100,
              outputTokens: 50,
              costUsd: '0.001',
              latencyMs: 900,
              retrievedMemoryIds: [MEM_1, MEM_GONE],
              output: { stance: 'BULL', confidence: 0.7 },
              createdAt: new Date('2026-07-09T13:00:02Z'),
            },
          ],
          debate: [
            { round: 1, seq: 0, speaker: 'bull', content: '{"argument":"edge"}' },
            { round: 1, seq: 1, speaker: 'bear', content: '{"argument":"risk"}' },
            { round: -1, seq: 2, speaker: 'judge', content: 'note: provider degraded' },
          ],
        };
      },
    },
    agentMemory: {
      findMany: async () => [
        {
          id: MEM_1,
          agentRole: 'pm',
          barTs: new Date('2026-07-08T13:00:00Z'),
          summary: 'similar setup won +1.8R',
          outcome: { rMultiple: 1.8 },
          createdAt: new Date('2026-07-08T13:05:00Z'),
        },
        // MEM_GONE deliberately absent — evicted since the original run.
      ],
    },
  } as unknown as PrismaClient;
}

describe('QN-062 — GET /signals/:id/replay', () => {
  it('404 for an unknown signal', async () => {
    app = await buildApp(testEnv(), { prisma: fakePrismaForReplay() });
    const res = await app.inject({
      method: 'GET',
      url: '/signals/00000000-0000-4000-8000-000000000000/replay',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SIGNAL_NOT_FOUND');
  });

  it('replays transcript + exact memory context and proxies the quant leg', async () => {
    const quantCalls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      quantCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ deterministic: true, featureDrift: [], notes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    app = await buildApp(testEnv(), {
      prisma: fakePrismaForReplay(),
      signals: { fetchImpl },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/signals/${SIGNAL_ID}/replay`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Full transcript (FE-060 detail beyond BE-067 summaries).
    expect(body.transcript).toHaveLength(3);
    expect(body.transcript[2].content).toContain('degraded');

    // LLM cached mode: stored output + provenance, no model re-invoked.
    expect(body.agentRuns).toHaveLength(1);
    expect(body.agentRuns[0]).toMatchObject({
      agentRole: 'technical_analyst',
      model: 'model-snapshot-1',
      promptHash: 'hash-1',
      output: { stance: 'BULL', confidence: 0.7 },
    });

    // Exact §9.5 memory context via retrieved_memory_ids (QN-062 AC),
    // with an evicted memory reported as a tombstone — never dropped.
    const memories = body.agentRuns[0].retrievedMemories;
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({ id: MEM_1, summary: 'similar setup won +1.8R' });
    expect(memories[1].id).toBe(MEM_GONE);
    expect(memories[1].summary).toContain('evicted');

    // Quant leg proxied with the stored point-in-time inputs.
    expect(body.quant).toMatchObject({ available: true, detail: null });
    expect(body.quant.report.deterministic).toBe(true);
    expect(quantCalls[0]?.url).toContain('/replay/quant');
    expect(quantCalls[0]?.body).toMatchObject({
      instrument: 'EUR_USD',
      timeframe: 'H1',
      barTs: '2026-07-09T13:00:00.000Z',
      candidate: { side: 'long', probability: 0.63, modelVersion: null },
    });
  });

  it('quant service down → transcript still serves, quant section honestly unavailable', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5001');
    }) as unknown as typeof fetch;
    app = await buildApp(testEnv(), {
      prisma: fakePrismaForReplay(),
      signals: { fetchImpl },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/signals/${SIGNAL_ID}/replay`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transcript).toHaveLength(3);
    expect(body.quant.available).toBe(false);
    expect(body.quant.detail).toContain('ECONNREFUSED');
    expect(body.quant.report).toBeNull();
  });
});
