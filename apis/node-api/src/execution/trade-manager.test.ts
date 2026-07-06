import { describe, expect, it } from 'vitest';
import {
  processTradeManagerTick,
  shouldUpdateSl,
  type TradeManagerDeps,
} from '../workers/trade-manager.js';
import { EXECUTION_HALT_KEY } from './halt.js';
import {
  type FakeQuantBehavior,
  type FakeTrade,
  fakeEnv,
  fakePrisma,
  fakeQuant,
  fakeRedis,
  makeDb,
} from './test-fakes.js';

describe('BE-051 trade manager', () => {
  it('never widens long stop loss', () => {
    expect(shouldUpdateSl('long', 1.09, 1.095)).toBe(true);
    expect(shouldUpdateSl('long', 1.095, 1.09)).toBe(false);
  });

  it('never widens short stop loss', () => {
    expect(shouldUpdateSl('short', 1.11, 1.105)).toBe(true);
    expect(shouldUpdateSl('short', 1.105, 1.11)).toBe(false);
  });
});

// entry 1.1000, SL 1.0900 → risk 0.01; +1R = 1.1100
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
    status: 'open',
    tradingMode: 'paper',
    meta: { originalRiskDistance: 0.01, originalStopLoss: 1.09 },
    ...over,
  };
}

function managerRig(quantBehavior: FakeQuantBehavior = {}, mid = 1.11) {
  const db = makeDb();
  db.ticks.set('EUR_USD', { bid: mid, ask: mid });
  const redisRig = fakeRedis();
  const quantRig = fakeQuant(quantBehavior);
  const deps: TradeManagerDeps = {
    prisma: fakePrisma(db),
    redis: redisRig.redis,
    quant: quantRig.quant,
    env: fakeEnv(),
  };
  return { db, redisRig, quantRig, deps };
}

describe('BE-051 trade manager tick (AC: +1R → partial + breakeven)', () => {
  it('at +1R: closes the configured fraction once and moves SL to breakeven', async () => {
    const r = managerRig(); // mid 1.11 = +1R
    r.db.trades.set('trade-1', openTrade());
    await processTradeManagerTick(r.deps);

    const closes = r.quantRig.calls.filter((c) => c.method === 'closeTrade');
    expect(closes).toEqual([{ method: 'closeTrade', args: ['bt-1', 5_000] }]); // 50% of 10k
    const trade = r.db.trades.get('trade-1');
    expect(trade?.units).toBe(5_000);
    // breakeven = entry + 0.05R buffer = 1.1 + 0.0005
    expect(trade?.stopLoss).toBeCloseTo(1.1005);
    expect((trade?.meta as { partialTakenAt?: string }).partialTakenAt).toBeTruthy();

    // second tick at the same price: partial must NOT repeat
    await processTradeManagerTick(r.deps);
    expect(r.quantRig.calls.filter((c) => c.method === 'closeTrade')).toHaveLength(1);
  });

  it('below +1R: does nothing', async () => {
    const r = managerRig({}, 1.105); // +0.5R
    r.db.trades.set('trade-1', openTrade());
    await processTradeManagerTick(r.deps);
    expect(r.quantRig.calls.filter((c) => c.method === 'closeTrade')).toHaveLength(0);
  });

  it('rejected breakeven modify is retried on the next tick until it sticks', async () => {
    let modifyCalls = 0;
    const r = managerRig({
      modifyTradeOk: () => {
        modifyCalls += 1;
        return modifyCalls >= 2; // first attempt rejected, second succeeds
      },
    });
    r.db.trades.set('trade-1', openTrade());

    await processTradeManagerTick(r.deps); // partial ok, breakeven rejected
    let trade = r.db.trades.get('trade-1');
    expect(trade?.stopLoss).toBe(1.09); // unchanged
    expect((trade?.meta as { breakevenSetAt?: string }).breakevenSetAt).toBeUndefined();

    await processTradeManagerTick(r.deps); // retry path
    trade = r.db.trades.get('trade-1');
    expect(trade?.stopLoss).toBeCloseTo(1.1005);
    expect((trade?.meta as { breakevenSetAt?: string }).breakevenSetAt).toBeTruthy();
    // the partial itself never repeated
    expect(r.quantRig.calls.filter((c) => c.method === 'closeTrade')).toHaveLength(1);
  });

  it('after breakeven: trails the stop but never widens it', async () => {
    const r = managerRig({}, 1.13); // deep in profit
    r.db.trades.set(
      'trade-1',
      openTrade({
        units: 5_000,
        stopLoss: 1.1005,
        meta: {
          originalRiskDistance: 0.01,
          originalStopLoss: 1.09,
          partialTakenAt: '2026-07-07T00:00:00Z',
          breakevenSetAt: '2026-07-07T00:00:00Z',
          trailActive: true,
          lastTrailSl: 1.1005,
        },
      }),
    );
    await processTradeManagerTick(r.deps);
    // trail = mid − 0.5R = 1.13 − 0.005
    expect(r.db.trades.get('trade-1')?.stopLoss).toBeCloseTo(1.125);

    // price falls back → proposed trail would be LOWER than current SL → no move
    r.db.ticks.set('EUR_USD', { bid: 1.12, ask: 1.12 });
    await processTradeManagerTick(r.deps);
    expect(r.db.trades.get('trade-1')?.stopLoss).toBeCloseTo(1.125); // never widened
  });

  it('halt flag → tick is a no-op', async () => {
    const r = managerRig();
    r.db.trades.set('trade-1', openTrade());
    r.redisRig.store.set(EXECUTION_HALT_KEY, '1');
    await processTradeManagerTick(r.deps);
    expect(r.quantRig.calls).toHaveLength(0);
  });

  it('backtest mode → tick is a no-op', async () => {
    const r = managerRig();
    r.db.trades.set('trade-1', openTrade());
    r.deps.env = fakeEnv({ TRADING_MODE: 'backtest' });
    await processTradeManagerTick(r.deps);
    expect(r.quantRig.calls).toHaveLength(0);
  });
});
