import { describe, expect, it } from 'vitest';
import {
  atrTrailLayer,
  DEFAULT_EXIT_CONFIG,
  ddHaltLayer,
  type ExitContext,
  evaluateExitLayers,
  hardStopLayer,
  preNewsFlattenLayer,
  timeStopLayer,
} from './layered-exits.js';

/** BE-081 — every layer tested in isolation; first-to-fire wins. */

function ctx(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    side: 'long',
    entryPrice: 1.1,
    currentPrice: 1.105,
    stopLoss: 1.09,
    takeProfit: 1.118,
    lastTrailSl: null,
    openedAt: new Date('2026-07-06T10:00:00Z'),
    now: new Date('2026-07-06T14:00:00Z'),
    equity: 10_000,
    dailyRealizedPnl: 0,
    calendarAvailable: false,
    highImpactEventWithinBlackout: false,
    config: DEFAULT_EXIT_CONFIG,
    ...overrides,
  };
}

describe('hard_sl_tp layer (isolation)', () => {
  it('fires when a long trades at/below the stop', () => {
    const r = hardStopLayer(ctx({ currentPrice: 1.09 }));
    expect(r.exit).toBe(true);
    if (r.exit) expect(r.layer).toBe('hard_sl_tp');
  });
  it('fires when a short trades at/above the stop', () => {
    const r = hardStopLayer(ctx({ side: 'short', stopLoss: 1.11, currentPrice: 1.111 }));
    expect(r.exit).toBe(true);
  });
  it('fires on take-profit touch', () => {
    const r = hardStopLayer(ctx({ currentPrice: 1.118 }));
    expect(r.exit).toBe(true);
  });
  it('stays quiet inside the bracket', () => {
    expect(hardStopLayer(ctx()).exit).toBe(false);
  });
  it('handles missing SL/TP without firing', () => {
    expect(hardStopLayer(ctx({ stopLoss: null, takeProfit: null })).exit).toBe(false);
  });
});

describe('dd_halt layer (isolation)', () => {
  it('fires at the 5% daily-loss threshold with flatten_all scope', () => {
    const r = ddHaltLayer(ctx({ dailyRealizedPnl: -500 }));
    expect(r.exit).toBe(true);
    if (r.exit) {
      expect(r.layer).toBe('dd_halt');
      expect(r.scope).toBe('flatten_all');
    }
  });
  it('ignores profits and small losses', () => {
    expect(ddHaltLayer(ctx({ dailyRealizedPnl: -499 })).exit).toBe(false);
    expect(ddHaltLayer(ctx({ dailyRealizedPnl: 500 })).exit).toBe(false);
  });
});

describe('pre_news_flatten layer (isolation)', () => {
  it('fires when the calendar reports a blackout event', () => {
    const r = preNewsFlattenLayer(
      ctx({ calendarAvailable: true, highImpactEventWithinBlackout: true }),
    );
    expect(r.exit).toBe(true);
    if (r.exit) expect(r.layer).toBe('pre_news_flatten');
  });
  it('records calendar_unavailable and does NOT exit (Phase-3 seam policy)', () => {
    const r = preNewsFlattenLayer(ctx({ calendarAvailable: false }));
    expect(r.exit).toBe(false);
    if (!r.exit) expect(r.note).toBe('calendar_unavailable');
  });
  it('stays quiet with a calendar and no event', () => {
    expect(preNewsFlattenLayer(ctx({ calendarAvailable: true })).exit).toBe(false);
  });
});

describe('time_stop layer (isolation)', () => {
  it('fires once the holding period exceeds the time stop', () => {
    const r = timeStopLayer(
      ctx({
        openedAt: new Date('2026-07-03T10:00:00Z'),
        now: new Date('2026-07-06T11:00:00Z'), // 73h
      }),
    );
    expect(r.exit).toBe(true);
    if (r.exit) expect(r.layer).toBe('time_stop');
  });
  it('stays quiet before the boundary', () => {
    expect(timeStopLayer(ctx()).exit).toBe(false); // 4h held
  });
});

describe('atr_trail layer (isolation)', () => {
  it('never fires before BE-051 activated a trail', () => {
    expect(atrTrailLayer(ctx({ lastTrailSl: null, currentPrice: 0.5 })).exit).toBe(false);
  });
  it('fires when a long crosses the trailed stop', () => {
    const r = atrTrailLayer(ctx({ lastTrailSl: 1.104, currentPrice: 1.103 }));
    expect(r.exit).toBe(true);
    if (r.exit) expect(r.layer).toBe('atr_trail');
  });
  it('fires when a short crosses the trailed stop upward', () => {
    const r = atrTrailLayer(ctx({ side: 'short', lastTrailSl: 1.096, currentPrice: 1.097 }));
    expect(r.exit).toBe(true);
  });
});

describe('first-to-fire priority (story AC)', () => {
  it('hard_sl_tp beats dd_halt when both would fire', () => {
    const result = evaluateExitLayers(ctx({ currentPrice: 1.05, dailyRealizedPnl: -5000 }));
    expect(result.decision?.layer).toBe('hard_sl_tp');
  });
  it('dd_halt beats time_stop when both would fire', () => {
    const result = evaluateExitLayers(
      ctx({
        dailyRealizedPnl: -5000,
        openedAt: new Date('2026-07-01T00:00:00Z'),
        now: new Date('2026-07-10T00:00:00Z'),
      }),
    );
    expect(result.decision?.layer).toBe('dd_halt');
  });
  it('returns null decision + calendar note when nothing fires', () => {
    const result = evaluateExitLayers(ctx());
    expect(result.decision).toBeNull();
    expect(result.notes).toContain('calendar_unavailable');
  });
});
