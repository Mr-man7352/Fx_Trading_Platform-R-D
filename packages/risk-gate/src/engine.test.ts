import { describe, expect, it } from 'vitest';
import { evaluateRiskGate } from './engine.js';
import { inFridayPreCloseWindow, isWeekendClosure, nyWallClock } from './ny-time.js';
import { DEFAULT_RISK_GATE_CONFIG, type RiskGateConfig, type RiskGateContext } from './types.js';

/**
 * BE-070/071 — unit tests per rule and combination (story AC), including the
 * mandated fixtures: NFP blackout, P=0.58 veto, instrument daily loss,
 * DST summer/winter regression, flash spread, correlation cap.
 */

// A Tuesday 14:00 UTC (10:00 NY, EDT) — well clear of every session rule.
const OPEN_BAR = new Date('2026-07-07T14:00:00Z');

function ctx(overrides: Partial<RiskGateContext> = {}): RiskGateContext {
  return {
    candidate: {
      instrument: 'EUR_USD',
      side: 'long',
      probability: 0.65,
      regime: 'TREND_UP',
      modelVersion: 'v1',
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11, // R:R = 2.0 gross
    },
    account: { equity: 10_000, openPositions: 0, dailyPnlPct: 0, openRiskPct: 0 },
    barTs: OPEN_BAR,
    degradedInstruments: [],
    killSwitchActive: false,
    weeklyPnlPct: 0,
    instrumentDailyLossPct: 0,
    openPositions: [],
    clusters: [],
    clusterSetVersion: null,
    calendarAvailable: false,
    upcomingEvents: [],
    sessionLabel: 'LONDON',
    liquidityRegime: 'NORMAL',
    spreadPips: 1,
    spreadPctile: 0.4,
    weekendGapWindow: false,
    ...overrides,
  };
}

function cfg(overrides: Partial<RiskGateConfig> = {}): RiskGateConfig {
  return { ...DEFAULT_RISK_GATE_CONFIG, ...overrides };
}

describe('baseline', () => {
  it('approves a clean candidate and records every rule', () => {
    const res = evaluateRiskGate(ctx(), cfg());
    expect(res.verdict).toBe('approve');
    expect(res.reasonCode).toBeNull();
    // ALL rules present in the audit record.
    for (const rule of [
      'kill_switch',
      'degraded_feed',
      'market_closed',
      'probability',
      'daily_drawdown',
      'weekly_drawdown',
      'instrument_daily_loss',
      'max_concurrent',
      'correlation_cap',
      'min_risk_reward',
      'flash_spread',
      'max_spread',
      'econ_blackout',
      'weekend_gap',
      'rollover',
    ]) {
      expect(res.checks[rule], rule).toBeDefined();
    }
  });

  it('keeps evaluating all rules after an early veto (complete audit record)', () => {
    const res = evaluateRiskGate(
      ctx({ killSwitchActive: true, candidate: { ...ctx().candidate, probability: 0.58 } }),
      cfg(),
    );
    expect(res.verdict).toBe('veto');
    expect(res.reasonCode).toBe('HALTED'); // first in §10 order
    expect(res.checks.probability?.pass).toBe(false); // later rule still evaluated
  });
});

describe('probability (ADR-008)', () => {
  it('vetoes P=0.58 with PROB_BELOW_THRESHOLD (story AC)', () => {
    const res = evaluateRiskGate(
      ctx({ candidate: { ...ctx().candidate, probability: 0.58 } }),
      cfg(),
    );
    expect(res.verdict).toBe('veto');
    expect(res.reasonCode).toBe('PROB_BELOW_THRESHOLD');
  });

  it('approves exactly at the threshold', () => {
    const res = evaluateRiskGate(
      ctx({ candidate: { ...ctx().candidate, probability: 0.6 } }),
      cfg(),
    );
    expect(res.checks.probability?.pass).toBe(true);
  });
});

describe('drawdown halts', () => {
  it('vetoes on daily drawdown breach (-5%)', () => {
    const res = evaluateRiskGate(
      ctx({ account: { ...ctx().account, dailyPnlPct: -0.051 } }),
      cfg(),
    );
    expect(res.reasonCode).toBe('DAILY_DD_HALT');
  });

  it('vetoes on weekly drawdown breach (-10%)', () => {
    const res = evaluateRiskGate(ctx({ weeklyPnlPct: -0.11 }), cfg());
    expect(res.reasonCode).toBe('WEEKLY_DD_HALT');
  });

  it('vetoes same-instrument entry after >2% instrument daily loss (story AC)', () => {
    const res = evaluateRiskGate(ctx({ instrumentDailyLossPct: 0.021 }), cfg());
    expect(res.reasonCode).toBe('INSTRUMENT_DAILY_LOSS');
  });

  it('does not veto at exactly 2% (tripwire is strict >)', () => {
    const res = evaluateRiskGate(ctx({ instrumentDailyLossPct: 0.02 }), cfg());
    expect(res.checks.instrument_daily_loss?.pass).toBe(true);
  });
});

describe('concurrency + correlation (BE-071)', () => {
  it('vetoes at max concurrent trades', () => {
    const res = evaluateRiskGate(ctx({ account: { ...ctx().account, openPositions: 5 } }), cfg());
    expect(res.reasonCode).toBe('MAX_CONCURRENT_TRADES');
  });

  it('passes the cluster cap when the candidate is the 2nd in its cluster', () => {
    const res = evaluateRiskGate(
      ctx({
        clusters: [['EUR_USD', 'GBP_USD'], ['USD_JPY']],
        clusterSetVersion: 3,
        openPositions: [{ instrument: 'GBP_USD', openedAt: OPEN_BAR }],
        account: { ...ctx().account, openPositions: 1 },
      }),
      cfg(),
    );
    expect(res.checks.correlation_cap?.pass).toBe(true);
    expect(res.verdict).toBe('approve');
  });

  it('vetoes the 3rd trade in a cluster (max 2 per cluster, §10)', () => {
    const res = evaluateRiskGate(
      ctx({
        clusters: [['EUR_USD', 'GBP_USD', 'AUD_USD']],
        clusterSetVersion: 3,
        openPositions: [
          { instrument: 'GBP_USD', openedAt: OPEN_BAR },
          { instrument: 'AUD_USD', openedAt: OPEN_BAR },
        ],
        account: { ...ctx().account, openPositions: 2 },
      }),
      cfg(),
    );
    expect(res.reasonCode).toBe('CORRELATION_CAP');
  });

  it('a NEW cluster set version re-checks open exposure (QN-048 refresh AC)', () => {
    // Same open book; the refreshed set now clusters EUR with the open pairs.
    const before = evaluateRiskGate(
      ctx({
        clusters: [['GBP_USD', 'AUD_USD']], // EUR not clustered
        clusterSetVersion: 3,
        openPositions: [
          { instrument: 'GBP_USD', openedAt: OPEN_BAR },
          { instrument: 'AUD_USD', openedAt: OPEN_BAR },
        ],
        account: { ...ctx().account, openPositions: 2 },
      }),
      cfg(),
    );
    expect(before.verdict).toBe('approve');
    const after = evaluateRiskGate(
      ctx({
        clusters: [['EUR_USD', 'GBP_USD', 'AUD_USD']], // risk-off convergence
        clusterSetVersion: 4,
        openPositions: [
          { instrument: 'GBP_USD', openedAt: OPEN_BAR },
          { instrument: 'AUD_USD', openedAt: OPEN_BAR },
        ],
        account: { ...ctx().account, openPositions: 2 },
      }),
      cfg(),
    );
    expect(after.reasonCode).toBe('CORRELATION_CAP');
  });

  it('operator exemption bypasses the cap and raises an audit flag', () => {
    const res = evaluateRiskGate(
      ctx({
        clusters: [['EUR_USD', 'GBP_USD', 'AUD_USD']],
        clusterSetVersion: 4,
        openPositions: [
          { instrument: 'GBP_USD', openedAt: OPEN_BAR },
          { instrument: 'AUD_USD', openedAt: OPEN_BAR },
        ],
        account: { ...ctx().account, openPositions: 2 },
      }),
      cfg({ clusterExemptInstruments: ['EUR_USD'] }),
    );
    expect(res.verdict).toBe('approve');
    expect(res.flags.map((f) => f.flag)).toContain('CLUSTER_EXEMPTION_USED');
  });

  it('no cluster set published ⇒ cap not evaluated, noted in checks', () => {
    const res = evaluateRiskGate(ctx({ clusters: [] }), cfg());
    expect(res.checks.correlation_cap?.pass).toBe(true);
    expect(res.checks.correlation_cap?.detail).toContain('no cluster set');
  });
});

describe('R:R and spread rules', () => {
  it('vetoes when R:R net of spread falls below 1.8', () => {
    // Gross R:R exactly 1.8; a 2-pip spread pushes net below.
    const res = evaluateRiskGate(
      ctx({
        candidate: {
          ...ctx().candidate,
          entryPrice: 1.1,
          stopLossPrice: 1.095,
          takeProfitPrice: 1.109,
        },
        spreadPips: 2,
      }),
      cfg(),
    );
    expect(res.reasonCode).toBe('RR_BELOW_MIN');
  });

  it('vetoes spread above the session-adjusted cap', () => {
    const res = evaluateRiskGate(ctx({ spreadPips: 3.5, sessionLabel: 'LONDON' }), cfg());
    expect(res.reasonCode).toBe('SPREAD_TOO_WIDE');
  });

  it('allows the same spread overnight (1.5× multiplier, §10)', () => {
    const res = evaluateRiskGate(ctx({ spreadPips: 3.5, sessionLabel: 'OFF_HOURS' }), cfg());
    expect(res.checks.max_spread?.pass).toBe(true);
  });

  it('flash spread (≥5× cap) vetoes with FLASH_SPREAD + critical alert (story AC)', () => {
    const res = evaluateRiskGate(ctx({ spreadPips: 15, spreadPctile: 1 }), cfg());
    expect(res.reasonCode).toBe('FLASH_SPREAD');
    expect(res.alerts.some((a) => a.severity === 'critical')).toBe(true);
    expect(res.flags.map((f) => f.flag)).toContain('HALT_NEW_ENTRIES');
  });

  it('XAU uses its own 50-pip (50¢) cap', () => {
    const res = evaluateRiskGate(
      ctx({
        candidate: {
          ...ctx().candidate,
          instrument: 'XAU_USD',
          entryPrice: 2400,
          stopLossPrice: 2395,
          takeProfitPrice: 2410,
        },
        spreadPips: 40,
      }),
      cfg(),
    );
    expect(res.checks.max_spread?.pass).toBe(true);
  });

  it('no spread feed ⇒ spread rules noted as not evaluated (dev/mock mode)', () => {
    const res = evaluateRiskGate(ctx({ spreadPips: null, spreadPctile: null }), cfg());
    expect(res.checks.max_spread?.detail).toContain('no spread feed');
    expect(res.verdict).toBe('approve');
  });
});

describe('economic blackout', () => {
  it('vetoes an NFP fixture: high-impact USD event 10 min after the bar (story AC)', () => {
    const res = evaluateRiskGate(
      ctx({
        calendarAvailable: true,
        upcomingEvents: [
          {
            ts: new Date(OPEN_BAR.getTime() + 10 * 60_000),
            impact: 'high',
            currencies: ['USD'],
          },
        ],
      }),
      cfg(),
    );
    expect(res.reasonCode).toBe('ECON_BLACKOUT');
  });

  it('ignores events outside ±30 min or wrong currency', () => {
    const res = evaluateRiskGate(
      ctx({
        calendarAvailable: true,
        upcomingEvents: [
          { ts: new Date(OPEN_BAR.getTime() + 45 * 60_000), impact: 'high', currencies: ['USD'] },
          { ts: new Date(OPEN_BAR.getTime() + 5 * 60_000), impact: 'high', currencies: ['JPY'] },
          { ts: new Date(OPEN_BAR.getTime() + 5 * 60_000), impact: 'medium', currencies: ['USD'] },
        ],
      }),
      cfg(),
    );
    expect(res.checks.econ_blackout?.pass).toBe(true);
  });

  it('no calendar vendor ⇒ noted as not evaluated, does not veto', () => {
    const res = evaluateRiskGate(ctx({ calendarAvailable: false }), cfg());
    expect(res.checks.econ_blackout?.detail).toContain('no calendar vendor');
  });
});

describe('DST-aware session rules (summer AND winter fixtures — story AC)', () => {
  // Friday 2026-07-10: NY close 17:00 EDT = 21:00 UTC.
  const SUMMER_IN_WINDOW = new Date('2026-07-10T19:00:00Z'); // 15:00 NY
  const SUMMER_OUTSIDE = new Date('2026-07-10T13:00:00Z'); // 09:00 NY
  // Friday 2026-01-09: NY close 17:00 EST = 22:00 UTC.
  const WINTER_IN_WINDOW = new Date('2026-01-09T20:00:00Z'); // 15:00 NY
  const WINTER_OUTSIDE = new Date('2026-01-09T14:00:00Z'); // 09:00 NY

  it('nyWallClock resolves EDT (summer) and EST (winter)', () => {
    expect(nyWallClock(new Date('2026-07-10T21:00:00Z'))).toEqual({
      weekday: 5,
      hour: 17,
      minute: 0,
    });
    expect(nyWallClock(new Date('2026-01-09T22:00:00Z'))).toEqual({
      weekday: 5,
      hour: 17,
      minute: 0,
    });
  });

  it('Friday pre-close window is DST-aware in both seasons', () => {
    expect(inFridayPreCloseWindow(SUMMER_IN_WINDOW)).toBe(true);
    expect(inFridayPreCloseWindow(SUMMER_OUTSIDE)).toBe(false);
    expect(inFridayPreCloseWindow(WINTER_IN_WINDOW)).toBe(true);
    expect(inFridayPreCloseWindow(WINTER_OUTSIDE)).toBe(false);
  });

  it('weekend closure starts at 17:00 NY Friday in both seasons', () => {
    expect(isWeekendClosure(new Date('2026-07-10T21:00:00Z'))).toBe(true); // EDT close
    expect(isWeekendClosure(new Date('2026-07-10T20:59:00Z'))).toBe(false);
    expect(isWeekendClosure(new Date('2026-01-09T22:00:00Z'))).toBe(true); // EST close
    expect(isWeekendClosure(new Date('2026-01-09T21:59:00Z'))).toBe(false);
  });

  it('Sunday reopens at 17:00 NY', () => {
    expect(isWeekendClosure(new Date('2026-07-12T20:59:00Z'))).toBe(true); // Sun 16:59 EDT
    expect(isWeekendClosure(new Date('2026-07-12T21:00:00Z'))).toBe(false); // Sun 17:00 EDT
  });

  it('MARKET_CLOSED veto inside the weekend closure', () => {
    const res = evaluateRiskGate(ctx({ barTs: new Date('2026-07-11T12:00:00Z') }), cfg());
    expect(res.reasonCode).toBe('MARKET_CLOSED');
  });
});

describe('weekend gap flatten (§10, optional)', () => {
  const FRI_WINDOW = new Date('2026-07-10T19:00:00Z'); // 15:00 NY Friday

  it('flags existing positions + vetoes new entry in high-vol window when enabled', () => {
    const res = evaluateRiskGate(
      ctx({
        barTs: FRI_WINDOW,
        weekendGapWindow: null, // force the engine's own DST computation
        liquidityRegime: 'LOW',
        openPositions: [{ instrument: 'USD_JPY', openedAt: OPEN_BAR }],
        account: { ...ctx().account, openPositions: 1 },
      }),
      cfg({ weekendFlattenEnabled: true }),
    );
    expect(res.reasonCode).toBe('WEEKEND_GAP_WINDOW');
    expect(res.flags.map((f) => f.flag)).toContain('WEEKEND_GAP_FLATTEN');
  });

  it('disabled (default) ⇒ window noted but no veto', () => {
    const res = evaluateRiskGate(
      ctx({ barTs: FRI_WINDOW, weekendGapWindow: null, liquidityRegime: 'LOW' }),
      cfg(),
    );
    expect(res.checks.weekend_gap?.pass).toBe(true);
  });

  it('normal regime ⇒ no veto even when enabled', () => {
    const res = evaluateRiskGate(
      ctx({ barTs: FRI_WINDOW, weekendGapWindow: null, liquidityRegime: 'NORMAL' }),
      cfg({ weekendFlattenEnabled: true }),
    );
    expect(res.checks.weekend_gap?.pass).toBe(true);
  });

  it('prefers the Python weekend_gap_window feature when present', () => {
    const res = evaluateRiskGate(
      ctx({ barTs: OPEN_BAR, weekendGapWindow: true, liquidityRegime: 'LOW' }),
      cfg({ weekendFlattenEnabled: true }),
    );
    expect(res.reasonCode).toBe('WEEKEND_GAP_WINDOW');
  });
});

describe('Wednesday rollover (triple swap)', () => {
  // Wednesday 2026-07-08 14:00 UTC = 10:00 NY (EDT).
  const WEDNESDAY = new Date('2026-07-08T14:00:00Z');

  it('flags XAU held >2 days on Wednesday; optional auto-flatten flag (story AC)', () => {
    const res = evaluateRiskGate(
      ctx({
        barTs: WEDNESDAY,
        openPositions: [
          { instrument: 'XAU_USD', openedAt: new Date('2026-07-05T10:00:00Z') }, // >2 days
        ],
        account: { ...ctx().account, openPositions: 1 },
      }),
      cfg({ rolloverAutoFlattenXau: true }),
    );
    expect(res.verdict).toBe('approve'); // advisory — never vetoes the entry
    const flagNames = res.flags.map((f) => f.flag);
    expect(flagNames).toContain('TRIPLE_SWAP_WARNING');
    expect(flagNames).toContain('ROLLOVER_AUTOFLATTEN_XAU');
  });

  it('no flag for freshly opened positions or non-Wednesdays', () => {
    const fresh = evaluateRiskGate(
      ctx({
        barTs: WEDNESDAY,
        openPositions: [{ instrument: 'XAU_USD', openedAt: new Date('2026-07-07T10:00:00Z') }],
        account: { ...ctx().account, openPositions: 1 },
      }),
      cfg(),
    );
    expect(fresh.flags).toHaveLength(0);
    const tuesday = evaluateRiskGate(
      ctx({
        openPositions: [{ instrument: 'XAU_USD', openedAt: new Date('2026-07-04T10:00:00Z') }],
        account: { ...ctx().account, openPositions: 1 },
      }),
      cfg(),
    );
    expect(tuesday.flags).toHaveLength(0);
  });
});

describe('degraded feed + kill switch', () => {
  it('vetoes an instrument flagged by the data-quality monitor (BE-044)', () => {
    const res = evaluateRiskGate(ctx({ degradedInstruments: ['EUR_USD'] }), cfg());
    expect(res.reasonCode).toBe('DEGRADED_FEED');
  });

  it('vetoes everything while the kill-switch is active', () => {
    const res = evaluateRiskGate(ctx({ killSwitchActive: true }), cfg());
    expect(res.reasonCode).toBe('HALTED');
  });
});
