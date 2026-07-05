import type { DataQualityFlag } from '@fx/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { DataQualityMonitor, type DataQualitySink, isLikelyMarketClosed } from './data-quality.js';

class CollectingSink implements DataQualitySink {
  flags: DataQualityFlag[] = [];
  record(flag: DataQualityFlag): void {
    this.flags.push(flag);
  }
}

let sink: CollectingSink;
let mon: DataQualityMonitor;

beforeEach(() => {
  sink = new CollectingSink();
  mon = new DataQualityMonitor(sink);
});

describe('gap detection (BE-044 acceptance)', () => {
  it('fires an alert and degrades the instrument on an injected gap', () => {
    // Two contiguous M1 bars first — no flag.
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:00:00Z'));
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:01:00Z'));
    expect(sink.flags).toHaveLength(0);

    // Inject a gap: jump to 14:10 (9 missing bars) mid-session.
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:10:00Z'));

    const gap = sink.flags.find((f) => f.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('critical');
    expect(gap?.degraded).toBe(true);
    expect(mon.isDegraded('EUR_USD')).toBe(true);
    expect(mon.degradedInstruments().map((f) => f.instrument)).toContain('EUR_USD');
  });

  it('does not flag a gap over the weekend close', () => {
    // Friday 20:59 → Sunday 21:01 UTC is the FX close; not a data gap.
    mon.observeBar('EUR_USD', 'H1', new Date('2026-03-13T20:00:00Z')); // Fri
    mon.observeBar('EUR_USD', 'H1', new Date('2026-03-15T21:00:00Z')); // Sun reopen
    expect(sink.flags.filter((f) => f.kind === 'gap')).toHaveLength(0);
  });

  it('clears gap degradation once contiguous bars resume', () => {
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:00:00Z'));
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:10:00Z')); // gap → degraded
    expect(mon.isDegraded('EUR_USD')).toBe(true);
    mon.observeBar('EUR_USD', 'M1', new Date('2026-03-10T14:11:00Z')); // contiguous
    expect(mon.isDegraded('EUR_USD')).toBe(false);
  });
});

describe('stale feed detection', () => {
  it('degrades after >30s without a tick and recovers on the next tick', () => {
    const t0 = new Date('2026-03-10T14:00:00Z');
    mon.observeTick('EUR_USD', t0, 1.085, 1.0851);
    mon.checkStale(new Date(t0.getTime() + 31_000));
    expect(mon.isDegraded('EUR_USD')).toBe(true);
    expect(sink.flags.at(-1)?.kind).toBe('stale');

    mon.observeTick('EUR_USD', new Date(t0.getTime() + 32_000), 1.085, 1.0851);
    expect(mon.isDegraded('EUR_USD')).toBe(false);
  });
});

describe('spread anomaly', () => {
  it('warns on a wide spread and marks critical when extreme', () => {
    // EUR_USD pip = 0.0001; 10-pip spread > 8-pip threshold (warn).
    mon.observeTick('EUR_USD', new Date('2026-03-10T14:00:00Z'), 1.085, 1.086);
    expect(sink.flags.at(-1)).toMatchObject({ kind: 'spread_anomaly', severity: 'warn' });

    // 30-pip spread (>3×) → critical + degraded.
    mon.observeTick('EUR_USD', new Date('2026-03-10T14:00:01Z'), 1.085, 1.088);
    expect(mon.isDegraded('EUR_USD')).toBe(true);
  });
});

describe('cross-check', () => {
  it('flags only when discrepancy exceeds tolerance', () => {
    mon.reportCrossCheck('EUR_USD', new Date('2026-03-10T14:00:00Z'), 0.5, 2);
    expect(sink.flags).toHaveLength(0);
    mon.reportCrossCheck('EUR_USD', new Date('2026-03-10T14:00:00Z'), 5, 2);
    expect(sink.flags.at(-1)).toMatchObject({ kind: 'cross_check', degraded: false });
  });
});

describe('isLikelyMarketClosed', () => {
  it('covers the FX weekend window', () => {
    expect(isLikelyMarketClosed(new Date('2026-03-14T12:00:00Z'))).toBe(true); // Sat
    expect(isLikelyMarketClosed(new Date('2026-03-15T12:00:00Z'))).toBe(true); // Sun am
    expect(isLikelyMarketClosed(new Date('2026-03-15T22:00:00Z'))).toBe(false); // Sun pm open
    expect(isLikelyMarketClosed(new Date('2026-03-11T12:00:00Z'))).toBe(false); // Wed
  });
});
