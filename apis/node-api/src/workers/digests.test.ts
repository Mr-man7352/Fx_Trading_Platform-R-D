import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../auth/email.js';
import type { PrismaClient } from '../db.js';
import { loadEnv } from '../env.js';
import { composeDigest, DIGEST_CRONS, type DigestStats, processDigestJob } from './digests.js';

/** BE-116 — digest composition + send/mock routing (22:00 UTC crons). */

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: 'test-internal-token-16ch',
    NEXTAUTH_SECRET: 'test-nextauth-secret-16ch',
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  });
}

const STATS: DigestStats = {
  from: new Date('2026-07-12T22:00:00Z'),
  to: new Date('2026-07-13T22:00:00Z'),
  closedTrades: 3,
  realizedPnl: 42.5,
  wins: 2,
  losses: 1,
  signalsCreated: 8,
  signalsExecuted: 3,
  llmCostUsd: 0.1234,
  killSwitchActivations: 0,
};

function fakePrisma(): PrismaClient {
  return {
    trade: {
      findMany: async () => [{ realizedPnl: 10 }, { realizedPnl: -4 }],
    },
    signal: { count: async () => 5 },
    agentRun: { aggregate: async () => ({ _sum: { costUsd: 0.05 } }) },
    killSwitchState: { count: async () => 1 },
  } as unknown as PrismaClient;
}

describe('composeDigest (BE-116)', () => {
  it('summarizes trades, P&L, cycles, LLM spend, and kill-switch events', () => {
    const { subject, text } = composeDigest('daily', 'paper', STATS);
    expect(subject).toContain('daily digest');
    expect(subject).toContain('3 closed');
    expect(text).toContain('Realized P&L: 42.50');
    expect(text).toContain('2 wins / 1 losses');
    expect(text).toContain('8 created, 3 executed');
    expect(text).toContain('$0.1234');
  });

  it('an empty window says so honestly (never fabricated numbers)', () => {
    const { text } = composeDigest('weekly', 'paper', {
      ...STATS,
      closedTrades: 0,
      wins: 0,
      losses: 0,
      realizedPnl: 0,
      signalsCreated: 0,
      signalsExecuted: 0,
    });
    expect(text).toContain('No trading activity in this window.');
  });
});

describe('processDigestJob', () => {
  it('logs only when DIGEST_EMAIL_TO is unset (mock-first)', async () => {
    const sent: EmailMessage[] = [];
    await processDigestJob(
      { data: { kind: 'daily' } },
      {
        prisma: fakePrisma(),
        env: testEnv(),
        sender: {
          send: async (m) => {
            sent.push(m);
          },
        },
      },
    );
    expect(sent).toHaveLength(0);
  });

  it('sends via the EmailSender when DIGEST_EMAIL_TO is set', async () => {
    const sent: EmailMessage[] = [];
    await processDigestJob(
      { data: { kind: 'weekly' } },
      {
        prisma: fakePrisma(),
        env: testEnv({ DIGEST_EMAIL_TO: 'operator@example.com' }),
        sender: {
          send: async (m) => {
            sent.push(m);
          },
        },
        now: () => new Date('2026-07-13T22:00:00Z'),
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('operator@example.com');
    expect(sent[0]?.subject).toContain('weekly digest');
    expect(sent[0]?.text).toContain('Kill-switch activations: 1');
  });
});

describe('DIGEST_CRONS', () => {
  it('daily at 22:00 UTC (AC) and weekly on Sunday 22:00 UTC', () => {
    expect(DIGEST_CRONS.find((c) => c.kind === 'daily')?.pattern).toBe('0 22 * * *');
    expect(DIGEST_CRONS.find((c) => c.kind === 'weekly')?.pattern).toBe('0 22 * * 0');
  });
});
