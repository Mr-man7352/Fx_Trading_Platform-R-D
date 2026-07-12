import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COST_PARAMS,
  effectiveSpreadPips,
  financingDays,
  type OpenPosition,
  pipSize,
  type SimBar,
  stepPosition,
} from './simulated-execution.js';

/** QN-056 — fill/cost parity with the Python engine (same fixtures). */

function pos(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    signalId: 's1',
    instrument: 'EUR_USD',
    side: 'long',
    entryTs: new Date('2026-07-06T10:00:00Z'), // Monday
    entryPrice: 1.1,
    stopLoss: 1.099,
    takeProfit: 1.1018,
    units: 10_000,
    riskDistance: 0.001,
    probability: 0.65,
    barsHeld: 0,
    entrySpreadPips: 0.8,
    ...overrides,
  };
}

function bar(overrides: Partial<SimBar> = {}): SimBar {
  return {
    ts: new Date('2026-07-06T11:00:00Z'),
    open: 1.1,
    high: 1.1005,
    low: 1.0995,
    close: 1.1,
    sessionLabel: 'LONDON',
    spreadPips: null,
    spreadPctile: null,
    ...overrides,
  };
}

describe('stepPosition', () => {
  it('TP exit: gross 18 pips minus entry spread', () => {
    const t = stepPosition(pos(), bar({ high: 1.102 }), 24, DEFAULT_COST_PARAMS, false);
    expect(t?.exitReason).toBe('TP');
    expect(t?.grossPips).toBeCloseTo(18);
    expect(t?.netPips).toBeCloseTo(18 - 0.8);
  });

  it('SL first when a bar spans both levels (conservative tie-break)', () => {
    const t = stepPosition(
      pos(),
      bar({ high: 1.102, low: 1.0989 }),
      24,
      DEFAULT_COST_PARAMS,
      false,
    );
    expect(t?.exitReason).toBe('SL');
    expect(t?.costs.slippagePips).toBeGreaterThan(0);
  });

  it('gap through the stop fills at the OPEN — loss beyond stop', () => {
    const t = stepPosition(
      pos(),
      bar({ open: 1.097, high: 1.0975, low: 1.096, close: 1.0965 }),
      24,
      DEFAULT_COST_PARAMS,
      false,
    );
    expect(t?.exitReason).toBe('GAP_SL');
    expect(t?.exitPrice).toBeCloseTo(1.097);
    expect(t?.costs.gapExcessPips).toBeCloseTo(20);
    expect(t?.rMultiple).toBeLessThan(-1);
  });

  it('flash bar (spread pctile >= 0.99) applies 10x stop slippage', () => {
    const t = stepPosition(
      pos(),
      bar({ low: 1.0985, close: 1.099, spreadPips: 1.0, spreadPctile: 0.995 }),
      24,
      DEFAULT_COST_PARAMS,
      false,
    );
    expect(t?.exitReason).toBe('SL');
    expect(t?.costs.flashEvent).toBe(true);
    expect(t?.costs.slippagePips).toBeCloseTo(1.0 * 0.5 * 10);
  });

  it('holds inside the bracket, then expires at the horizon close', () => {
    const p = pos();
    expect(stepPosition(p, bar(), 3, DEFAULT_COST_PARAMS, false)).toBeNull();
    expect(p.barsHeld).toBe(1);
    expect(stepPosition(p, bar(), 3, DEFAULT_COST_PARAMS, false)).toBeNull();
    const t = stepPosition(p, bar({ close: 1.1004 }), 3, DEFAULT_COST_PARAMS, false);
    expect(t?.exitReason).toBe('EXPIRY');
    expect(t?.grossPips).toBeCloseTo(4);
  });

  it('short positions mirror the geometry', () => {
    const t = stepPosition(
      pos({ side: 'short', stopLoss: 1.101, takeProfit: 1.0982 }),
      bar({ low: 1.098 }),
      24,
      DEFAULT_COST_PARAMS,
      false,
    );
    expect(t?.exitReason).toBe('TP');
    expect(t?.grossPips).toBeCloseTo(18);
  });
});

describe('financingDays (DST-aware 17:00 New York)', () => {
  it('no crossing inside one NY day', () => {
    expect(
      financingDays(new Date('2026-07-06T10:00:00Z'), new Date('2026-07-06T15:00:00Z')),
    ).toEqual({ days: 0, crossings: 0, triples: 0 });
  });
  it('Mon→Thu crosses 3 rollovers; Wednesday books triple (5 days total)', () => {
    const r = financingDays(new Date('2026-07-06T12:00:00Z'), new Date('2026-07-09T12:00:00Z'));
    expect(r.crossings).toBe(3);
    expect(r.triples).toBe(1);
    expect(r.days).toBe(5);
  });
});

describe('cost tables', () => {
  it('pip sizes match the Python engine', () => {
    expect(pipSize('EUR_USD')).toBe(0.0001);
    expect(pipSize('USD_JPY')).toBe(0.01);
    expect(pipSize('XAU_USD')).toBe(0.01);
  });
  it('session multiplier applies off-hours', () => {
    expect(effectiveSpreadPips('EUR_USD', null, 'OFF_HOURS')).toBeCloseTo(0.8 * 1.5);
    expect(effectiveSpreadPips('EUR_USD', 1.7, 'OFF_HOURS')).toBe(1.7);
  });
});
