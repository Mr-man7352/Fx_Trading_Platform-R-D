/**
 * BE-023 — deterministic dev seeds: test user, invite code, 2 days of M1
 * EUR/USD candles, one fixture signal (+ baseline shadow row) and a sealed
 * practice broker credential. Idempotent: upserts + createMany(skipDuplicates),
 * so `pnpm seed:dev` can run repeatedly.
 *
 * Run `pnpm db:timescale -- --refresh` afterwards if you want the seeded
 * candles materialized into the M5…D1 continuous aggregates.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { parseEncryptionKey, sealCredentials } from '../src/crypto/credentials.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const SEED_USER_EMAIL = 'dev@fx.local';
const SEED_INVITE_CODE = 'FX-DEV-0001';
const SEED_SIGNAL_ID = '00000000-0000-4000-8000-000000000001';
const INSTRUMENT = 'EUR_USD';
const CANDLE_MINUTES = 2 * 24 * 60; // 2 days of M1
const SEED_START = new Date('2026-06-29T00:00:00.000Z');

/** Deterministic LCG so every dev sees identical data. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    // ── Test user + invite code ──────────────────────────────────────────────
    const user = await prisma.user.upsert({
      where: { email: SEED_USER_EMAIL },
      update: {},
      create: {
        email: SEED_USER_EMAIL,
        name: 'FX Dev',
        role: 'admin',
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await prisma.inviteCode.upsert({
      where: { code: SEED_INVITE_CODE },
      update: {},
      create: { code: SEED_INVITE_CODE, createdById: user.id, maxUses: 5 },
    });

    // ── Sample candles: deterministic M1 random walk around 1.0850 ──────────
    const rand = lcg(42);
    let close = 1.085;
    const candles = [];
    for (let i = 0; i < CANDLE_MINUTES; i++) {
      const ts = new Date(SEED_START.getTime() + i * 60_000);
      const open = close;
      const drift = (rand() - 0.5) * 0.0004;
      close = Number((open + drift).toFixed(5));
      const high = Number((Math.max(open, close) + rand() * 0.0001).toFixed(5));
      const low = Number((Math.min(open, close) - rand() * 0.0001).toFixed(5));
      candles.push({
        instrument: INSTRUMENT,
        timeframe: 'M1' as const,
        ts,
        open,
        high,
        low,
        close,
        volume: Math.round(50 + rand() * 200),
        source: 'seed',
      });
    }
    const inserted = await prisma.candle.createMany({ data: candles, skipDuplicates: true });

    // ── Fixture signal + shadow baseline row ─────────────────────────────────
    const barTs = new Date(SEED_START.getTime() + (CANDLE_MINUTES - 60) * 60_000);
    await prisma.signal.upsert({
      where: { id: SEED_SIGNAL_ID },
      update: {},
      create: {
        id: SEED_SIGNAL_ID,
        barTs,
        instrument: INSTRUMENT,
        timeframe: 'H1',
        side: 'long',
        entryPrice: 1.0862,
        stopLoss: 1.0832,
        takeProfit: 1.0922,
        quantScore: 0.71,
        metaProbability: 0.63,
        status: 'candidate',
        tradingMode: 'paper',
        features: { sessionLabel: 'london', liquidityRegime: 'normal', seed: true },
      },
    });
    await prisma.baselineSignal.createMany({
      data: [
        {
          barTs,
          instrument: INSTRUMENT,
          timeframe: 'H1',
          side: 'long',
          quantScore: 0.71,
          wouldTrade: true,
          meta: { seed: true },
        },
      ],
      skipDuplicates: true,
    });

    // ── Sealed practice broker credential (BE-131 seed path) ────────────────
    const keyB64 = process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (keyB64) {
      const key = parseEncryptionKey(keyB64);
      await prisma.brokerCredential.upsert({
        where: {
          userId_broker_environment_label: {
            userId: user.id,
            broker: 'oanda',
            environment: 'practice',
            label: 'default',
          },
        },
        update: {},
        create: {
          userId: user.id,
          broker: 'oanda',
          environment: 'practice',
          label: 'default',
          ciphertext: sealCredentials(
            { apiToken: 'seed-practice-token-not-real', accountId: '101-004-0000000-001' },
            key,
          ),
        },
      });
    } else {
      console.warn('⚠️  CREDENTIALS_ENCRYPTION_KEY not set — skipping broker credential seed.');
    }

    console.log(
      `✅ Seeded: user ${SEED_USER_EMAIL}, invite ${SEED_INVITE_CODE}, ${inserted.count} new candles (of ${candles.length}), fixture signal ${SEED_SIGNAL_ID}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
