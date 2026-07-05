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
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
}

/** Prisma stand-in returning fixed candles; enough surface for these routes. */
function fakePrismaWithCandles(rows: { ts: Date; close: number }[]) {
  return {
    $disconnect: async () => {},
    candle: {
      findMany: async ({ take }: { take: number }) =>
        rows.slice(0, take).map((r) => ({
          instrument: 'EUR_USD',
          timeframe: 'H1',
          ts: r.ts,
          open: r.close,
          high: r.close,
          low: r.close,
          close: r.close,
          volume: 1,
          complete: true,
          source: 'oanda',
        })),
    },
  } as unknown as PrismaClient;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('BE-045 — GET /market/instruments', () => {
  it('returns the static registry with broker mappings (no DB required)', async () => {
    app = await buildApp(testEnv());
    const res = await app.inject({ method: 'GET', url: '/market/instruments', headers: auth });
    expect(res.statusCode).toBe(200);
    const { instruments } = res.json();
    const eur = instruments.find((i: { name: string }) => i.name === 'EUR_USD');
    expect(eur).toMatchObject({ oandaSymbol: 'EUR_USD', twelveDataSymbol: 'EUR/USD', pipLocation: -4 });
    expect(instruments.some((i: { name: string }) => i.name === 'XAU_USD')).toBe(true);
  });
});

describe('BE-045 — GET /market/candles', () => {
  it('503 when built without a DB client', async () => {
    app = await buildApp(testEnv());
    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?instrument=EUR_USD&timeframe=H1',
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DB_UNAVAILABLE');
  });

  it('400 on a missing instrument (Zod validation)', async () => {
    app = await buildApp(testEnv(), { prisma: fakePrismaWithCandles([]) });
    const res = await app.inject({ method: 'GET', url: '/market/candles?timeframe=H1', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('400 on an unknown (but well-formed) instrument', async () => {
    app = await buildApp(testEnv(), { prisma: fakePrismaWithCandles([]) });
    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?instrument=ZZZ_ZZZ&timeframe=H1',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_INSTRUMENT');
  });

  it('returns typed OHLCV and a nextFrom cursor when the page is full', async () => {
    const rows = [
      { ts: new Date('2026-03-10T14:00:00Z'), close: 1.08 },
      { ts: new Date('2026-03-10T15:00:00Z'), close: 1.081 },
    ];
    app = await buildApp(testEnv(), { prisma: fakePrismaWithCandles(rows) });
    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?instrument=EUR_USD&timeframe=H1&limit=2',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instrument).toBe('EUR_USD');
    expect(body.candles).toHaveLength(2);
    expect(body.candles[0]).toMatchObject({ open: 1.08, close: 1.08, timeframe: 'H1' });
    // Page full (== limit) → cursor is last ts + 1ms.
    expect(body.nextFrom).toBe('2026-03-10T15:00:00.001Z');
  });

  it('nextFrom is null when the page is not full', async () => {
    app = await buildApp(testEnv(), {
      prisma: fakePrismaWithCandles([{ ts: new Date('2026-03-10T14:00:00Z'), close: 1.08 }]),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?instrument=EUR_USD&timeframe=H1&limit=500',
      headers: auth,
    });
    expect(res.json().nextFrom).toBeNull();
  });
});

describe('BE-042 — GET /market/news', () => {
  it('503 without a DB client', async () => {
    app = await buildApp(testEnv());
    const res = await app.inject({ method: 'GET', url: '/market/news?asOf=2026-03-10T10:00:00Z', headers: auth });
    expect(res.statusCode).toBe(503);
  });
});
