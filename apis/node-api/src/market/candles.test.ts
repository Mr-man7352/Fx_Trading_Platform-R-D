import { describe, expect, it } from 'vitest';
import { bucketStart, CandleAggregator, nextBucketStart, type Tick } from './candles.js';

const at = (iso: string): Date => new Date(iso);
const tick = (iso: string, mid: number, volume?: number): Tick => ({ ts: at(iso), mid, volume });

describe('bucketStart', () => {
  it('floors to the M1 boundary', () => {
    expect(bucketStart(at('2026-03-10T14:07:42.500Z'), 'M1').toISOString()).toBe(
      '2026-03-10T14:07:00.000Z',
    );
  });

  it('floors to the H1 boundary', () => {
    expect(bucketStart(at('2026-03-10T14:59:59.999Z'), 'H1').toISOString()).toBe(
      '2026-03-10T14:00:00.000Z',
    );
  });

  it('floors H4 aligned to 00:00 UTC', () => {
    expect(bucketStart(at('2026-03-10T13:30:00Z'), 'H4').toISOString()).toBe(
      '2026-03-10T12:00:00.000Z',
    );
  });

  it('floors D1 to 00:00 UTC', () => {
    expect(bucketStart(at('2026-03-10T23:59:00Z'), 'D1').toISOString()).toBe(
      '2026-03-10T00:00:00.000Z',
    );
  });

  it('floors W1 to Monday 00:00 UTC', () => {
    // 2026-03-11 is a Wednesday → Monday is 2026-03-09.
    expect(bucketStart(at('2026-03-11T09:00:00Z'), 'W1').toISOString()).toBe(
      '2026-03-09T00:00:00.000Z',
    );
  });

  it('nextBucketStart advances one bar', () => {
    expect(nextBucketStart(at('2026-03-10T14:07:00Z'), 'H1').toISOString()).toBe(
      '2026-03-10T15:00:00.000Z',
    );
  });
});

describe('CandleAggregator', () => {
  it('builds one M1 OHLCV bar from several ticks', () => {
    const agg = new CandleAggregator('EUR_USD', 'M1');
    expect(agg.add(tick('2026-03-10T14:00:05Z', 1.085))).toEqual([]);
    expect(agg.add(tick('2026-03-10T14:00:20Z', 1.087))).toEqual([]);
    expect(agg.add(tick('2026-03-10T14:00:55Z', 1.084))).toEqual([]);

    const forming = agg.snapshot();
    expect(forming).toMatchObject({
      instrument: 'EUR_USD',
      timeframe: 'M1',
      ts: '2026-03-10T14:00:00.000Z',
      open: 1.085,
      high: 1.087,
      low: 1.084,
      close: 1.084,
      volume: 3,
      complete: false,
    });
  });

  it('closes the bar when a tick crosses into the next bucket', () => {
    const agg = new CandleAggregator('EUR_USD', 'M1');
    agg.add(tick('2026-03-10T14:00:05Z', 1.085));
    agg.add(tick('2026-03-10T14:00:59Z', 1.09));
    const closed = agg.add(tick('2026-03-10T14:01:03Z', 1.091));

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      ts: '2026-03-10T14:00:00.000Z',
      open: 1.085,
      high: 1.09,
      close: 1.09,
      complete: true,
    });
    // A new forming bar has started for 14:01.
    expect(agg.snapshot()?.ts).toBe('2026-03-10T14:01:00.000Z');
  });

  it('does not synthesise bars across a gap (skipped buckets stay empty)', () => {
    const agg = new CandleAggregator('EUR_USD', 'M1');
    agg.add(tick('2026-03-10T14:00:10Z', 1.085));
    const closed = agg.add(tick('2026-03-10T14:05:10Z', 1.088));
    // Only the 14:00 bar closes; 14:01–14:04 are NOT fabricated.
    expect(closed).toHaveLength(1);
    expect(closed[0]?.ts).toBe('2026-03-10T14:00:00.000Z');
    expect(agg.snapshot()?.ts).toBe('2026-03-10T14:05:00.000Z');
  });

  it('drops out-of-order ticks older than the open bar', () => {
    const agg = new CandleAggregator('EUR_USD', 'M1');
    agg.add(tick('2026-03-10T14:00:30Z', 1.085)); // opens the 14:00 bar
    agg.add(tick('2026-03-10T13:59:50Z', 9.999)); // from a prior bucket → ignored
    expect(agg.snapshot()).toMatchObject({
      ts: '2026-03-10T14:00:00.000Z',
      high: 1.085,
      low: 1.085,
      volume: 1,
    });
  });

  it('flush force-closes the open bar', () => {
    const agg = new CandleAggregator('EUR_USD', 'M1');
    agg.add(tick('2026-03-10T14:00:30Z', 1.085));
    expect(agg.flush()?.complete).toBe(true);
    expect(agg.flush()).toBeNull();
  });
});
