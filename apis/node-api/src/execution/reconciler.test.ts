import * as grpc from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import type { ExecutionDeps } from '../workers/execution.js';
import type { NotificationJob, SupervisionJob } from '../workers/queues.js';
import {
  detectMismatches,
  processReconciliationTick,
  type ReconcilerDeps,
} from '../workers/reconciler.js';
import { EXECUTION_HALT_KEY, RECONCILE_MISMATCH_METRIC_KEY } from './halt.js';
import { isUnknownOutcome } from './quant-client.js';
import {
  type FakeQuantBehavior,
  type FakeTrade,
  fakeEnv,
  fakePrisma,
  fakeQuant,
  fakeQueue,
  fakeRedis,
  makeDb,
  txn,
  wsEvents,
} from './test-fakes.js';

function openTrade(over: Partial<FakeTrade> = {}): FakeTrade {
  return {
    id: 'trade-1',
    intentId: 'intent-1',
    instrument: 'EUR_USD',
    side: 'long',
    units: 10_000,
    entryPrice: 1.1,
    stopLoss: 1.09,
    brokerTradeId: 'bt-1',
    realizedPnl: null,
    swapPnl: 0,
    commission: 0,
    status: 'open',
    tradingMode: 'paper',
    meta: { originalRiskDistance: 0.01, originalStopLoss: 1.09 },
    ...over,
  };
}

function reconcilerRig(
  quantBehavior: FakeQuantBehavior = {},
  envOver: Record<string, unknown> = {},
) {
  const db = makeDb();
  const redisRig = fakeRedis();
  const quantRig = fakeQuant(quantBehavior);
  const notifications = fakeQueue<NotificationJob>();
  const supervision = fakeQueue<SupervisionJob>();
  const prisma = fakePrisma(db);
  const env = fakeEnv(envOver);
  const executionDeps: ExecutionDeps = {
    prisma,
    redis: redisRig.redis,
    quant: quantRig.quant,
    supervisionQueue: supervision.queue,
    notificationsQueue: notifications.queue,
    env,
  };
  const deps: ReconcilerDeps = {
    prisma,
    redis: redisRig.redis,
    quant: quantRig.quant,
    notificationsQueue: notifications.queue,
    executionDeps,
    env,
  };
  return { db, redisRig, quantRig, notifications, deps };
}

describe('BE-050 quant client', () => {
  it('treats gRPC timeout as unknown outcome', () => {
    const err = Object.assign(new Error('deadline'), { code: grpc.status.DEADLINE_EXCEEDED });
    expect(isUnknownOutcome(err)).toBe(true);
  });
});

describe('BE-052 reconciler', () => {
  it('detects unknown broker position mismatch', () => {
    const mismatches = detectMismatches(
      [
        {
          instrument: 'EUR_USD',
          side: 'long',
          units: 1000,
          avgPrice: 1.1,
          unrealizedPl: 0,
          brokerTradeIds: ['999'],
        },
      ],
      [],
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.kind).toBe('unknown_broker_position');
  });

  it('detects DB trade missing at broker', () => {
    const mismatches = detectMismatches(
      [],
      [
        {
          id: 't1',
          instrument: 'EUR_USD',
          side: 'long',
          units: 1000,
          brokerTradeId: '123',
        },
      ],
    );
    expect(mismatches[0]?.kind).toBe('missing_at_broker');
  });
});

describe('BE-052 reconciliation tick — transaction sync', () => {
  it('persists the bootstrap high-water mark even when no transactions arrive', async () => {
    const r = reconcilerRig({ transactions: [], lastTxnId: '1000' });
    await processReconciliationTick(r.deps);
    expect(r.redisRig.store.get('reconciler:since_txn_id')).toBe('1000');
    // next tick polls from the persisted id
    await processReconciliationTick(r.deps);
    const calls = r.quantRig.calls.filter((c) => c.method === 'getTransactions');
    expect(calls[1]?.args[0]).toBe('1000');
  });

  it('broker-side SL close (tradesClosed) → DB trade closed with accumulated P&L, no halt', async () => {
    const r = reconcilerRig({
      transactions: [
        txn({
          reason: 'STOP_LOSS_ORDER',
          commission: 2,
          tradesClosed: [
            { tradeId: 'bt-1', units: 10_000, price: 1.09, realizedPl: -100, financing: -1 },
          ],
        }),
      ],
      lastTxnId: '2001',
      positions: [], // broker flat after the SL — consistent with closed DB row
    });
    r.db.trades.set('trade-1', openTrade());
    await processReconciliationTick(r.deps);

    const trade = r.db.trades.get('trade-1');
    expect(trade?.status).toBe('closed');
    expect(trade?.exitPrice).toBe(1.09);
    expect(trade?.realizedPnl).toBeCloseTo(-100 + -1 - 2);
    expect(trade?.swapPnl).toBeCloseTo(-1);
    expect(r.redisRig.store.get(EXECUTION_HALT_KEY)).toBeUndefined(); // expected transition — silent
    expect(wsEvents(r.redisRig).map((e) => e.channel)).toContain('pnl.update');
  });

  it('partial close (tradeReduced) → P&L accumulated, trade stays open, units untouched', async () => {
    const r = reconcilerRig({
      transactions: [
        txn({
          tradeReduced: {
            tradeId: 'bt-1',
            units: 5_000,
            price: 1.12,
            realizedPl: 100,
            financing: 0.5,
          },
        }),
      ],
      lastTxnId: '2001',
      positions: [
        {
          instrument: 'EUR_USD',
          side: 'long',
          units: 5_000,
          avgPrice: 1.1,
          unrealizedPl: 0,
          brokerTradeIds: ['bt-1'],
        },
      ],
    });
    // Trade manager already reduced units to 5k when it took the partial.
    r.db.trades.set('trade-1', openTrade({ units: 5_000 }));
    await processReconciliationTick(r.deps);

    const trade = r.db.trades.get('trade-1');
    expect(trade?.status).toBe('open');
    expect(trade?.units).toBe(5_000);
    expect(trade?.realizedPnl).toBeCloseTo(100.5);
    expect(r.redisRig.store.get(EXECUTION_HALT_KEY)).toBeUndefined();
  });

  it('fill for a submitted intent (lost gRPC response) → BE-050 persistence completed', async () => {
    const r = reconcilerRig({
      transactions: [txn({ clientOrderId: 'intent-1', tradeOpenedId: 'bt-9' })],
      lastTxnId: '2001',
      positions: [
        {
          instrument: 'EUR_USD',
          side: 'long',
          units: 10_000,
          avgPrice: 1.1,
          unrealizedPl: 0,
          brokerTradeIds: ['bt-1'],
        },
      ],
    });
    r.db.intents.set('intent-1', {
      id: 'intent-1',
      instrument: 'EUR_USD',
      side: 'long',
      units: 10_000,
      entryPrice: 1.1,
      stopLoss: 1.09,
      takeProfit: null,
      status: 'submitted',
      tradingMode: 'paper',
    });
    await processReconciliationTick(r.deps);

    expect(r.db.intents.get('intent-1')?.status).toBe('executed');
    // placeOrder re-issued with the same client id — adapter duplicate-recovery
    // returns the ORIGINAL fill (pinned Python-side).
    expect(
      r.quantRig.calls.some(
        (c) =>
          c.method === 'placeOrder' &&
          (c.args[0] as { clientOrderId: string }).clientOrderId === 'intent-1',
      ),
    ).toBe(true);
    expect([...r.db.trades.values()]).toHaveLength(1);
  });
});

describe('BE-052 reconciliation tick — mismatch actions (AC)', () => {
  const unknownPosition = {
    instrument: 'EUR_USD',
    side: 'long' as const,
    units: 7_000,
    avgPrice: 1.1,
    unrealizedPl: 0,
    brokerTradeIds: ['rogue-1'],
  };

  it('injected mismatch + RECONCILE_ACTION=halt → sticky halt, metric, WS events, critical alert', async () => {
    const r = reconcilerRig({ positions: [unknownPosition], lastTxnId: '1000' });
    await processReconciliationTick(r.deps);

    expect(r.redisRig.store.get(EXECUTION_HALT_KEY)).toBe('1');
    expect(r.redisRig.store.get(RECONCILE_MISMATCH_METRIC_KEY)).toBe('1');
    const channels = wsEvents(r.redisRig).map((e) => e.channel);
    expect(channels).toContain('reconciliation.mismatch');
    expect(channels).toContain('risk.halt');
    expect(r.notifications.jobs.some((j) => j.data.severity === 'critical')).toBe(true);
    expect(r.quantRig.calls.filter((c) => c.method === 'closeTrade')).toHaveLength(0);
  });

  it('RECONCILE_ACTION=flatten_and_halt → closes all broker trades, then halts', async () => {
    const r = reconcilerRig(
      { positions: [unknownPosition], lastTxnId: '1000' },
      { RECONCILE_ACTION: 'flatten_and_halt' },
    );
    await processReconciliationTick(r.deps);

    const closes = r.quantRig.calls.filter((c) => c.method === 'closeTrade');
    expect(closes.map((c) => c.args[0])).toEqual(['rogue-1']);
    expect(r.redisRig.store.get(EXECUTION_HALT_KEY)).toBe('1');
  });

  it('clean state → no halt, no alerts', async () => {
    const r = reconcilerRig({
      positions: [
        {
          instrument: 'EUR_USD',
          side: 'long',
          units: 10_000,
          avgPrice: 1.1,
          unrealizedPl: 0,
          brokerTradeIds: ['bt-1'],
        },
      ],
      lastTxnId: '1000',
    });
    r.db.trades.set('trade-1', openTrade());
    await processReconciliationTick(r.deps);

    expect(r.redisRig.store.get(EXECUTION_HALT_KEY)).toBeUndefined();
    expect(r.notifications.jobs).toHaveLength(0);
  });
});
