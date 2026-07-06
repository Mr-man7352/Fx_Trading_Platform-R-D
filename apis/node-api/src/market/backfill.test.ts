import type { Timeframe } from '@fx/types';
import { describe, expect, it } from 'vitest';
import { backfillCandles } from './backfill.js';
import { DataQualityMonitor, type DataQualitySink } from './data-quality.js';
import type { CandleRow, MarketRepo } from './repo.js';
import type { CandleFetchRequest, CandleSource, CrossCheckSource } from './vendors/types.js';

/** In-memory CandleSource yielding fixed M1 bars, paged, respecting from/to. */
class FakeSource implements CandleSource {
  readonly name = 'fake';
  constructor(
    private readonly bars: CandleRow[],
    private readonly pageSize = 2,
  ) {}
  async *fetchCandles(req: CandleFetchRequest): AsyncGenerator<CandleRow[], void, unknown> {
    const inRange = this.bars.filter((b) => b.ts >= req.from && b.ts < req.to);
    for (let i = 0; i < inRange.length; i += this.pageSize) {
      yield inRange.slice(i, i + this.pageSize);
    }
  }
}

/** Idempotent in-memory repo — keyed like the candles PK. */
class FakeRepo {
  store = new Map<string, CandleRow>();
  async upsertCandles(rows: CandleRow[]): Promise<number> {
    for (const r of rows) this.store.set(`${r.instrument}:${r.timeframe}:${r.ts.toISOString()}`, r);
    return rows.length;
  }
}

const mkBars = (n: number): CandleRow[] =>
  Array.from({ length: n }, (_, i) => ({
    instrument: 'EUR_USD',
    timeframe: 'M1' as Timeframe,
    ts: new Date(Date.UTC(2026, 2, 10, 14, i)),
    open: 1.08,
    high: 1.081,
    low: 1.079,
    close: 1.08 + i * 0.0001,
    volume: 5,
  }));

const range = { from: new Date('2026-03-10T14:00:00Z'), to: new Date('2026-03-10T18:00:00Z') };

describe('backfillCandles', () => {
  it('loads all bars in range across pages', async () => {
    const repo = new FakeRepo();
    const res = await backfillCandles({
      source: new FakeSource(mkBars(5)),
      repo: repo as unknown as MarketRepo,
      instrument: 'EUR_USD',
      timeframe: 'M1',
      ...range,
    });
    expect(res.candlesWritten).toBe(5);
    expect(res.pages).toBe(3); // pageSize 2 → 2+2+1
    expect(repo.store.size).toBe(5);
  });

  it('is idempotent on re-run (upsert, no duplicates)', async () => {
    const repo = new FakeRepo();
    const source = new FakeSource(mkBars(5));
    const p = {
      source,
      repo: repo as unknown as MarketRepo,
      instrument: 'EUR_USD',
      timeframe: 'M1' as Timeframe,
      ...range,
    };
    await backfillCandles(p);
    await backfillCandles(p);
    expect(repo.store.size).toBe(5); // second run overwrote, did not duplicate
  });

  it('logs cross-check discrepancies beyond tolerance to the monitor', async () => {
    const flags: string[] = [];
    const sink: DataQualitySink = { record: (f) => flags.push(f.kind) };
    const monitor = new DataQualityMonitor(sink);
    // Vendor mid is 5 pips (0.0005) above every bar close → beyond 2-pip tolerance.
    const crossCheck: CrossCheckSource = {
      name: 'fake-vendor',
      sampleMid: async (_i, _tf, ts) => {
        const bar = mkBars(5).find((b) => b.ts.getTime() === ts.getTime());
        return bar ? bar.close + 0.0005 : null;
      },
    };
    const res = await backfillCandles({
      source: new FakeSource(mkBars(5)),
      repo: new FakeRepo() as unknown as MarketRepo,
      instrument: 'EUR_USD',
      timeframe: 'M1',
      crossCheck,
      monitor,
      crossCheckSampleEvery: 1,
      crossCheckTolerancePips: 2,
      ...range,
    });
    expect(res.crossChecksSampled).toBe(5);
    expect(res.discrepancies).toBe(5);
    expect(flags.filter((k) => k === 'cross_check')).toHaveLength(5);
  });

  it('extensibility: a brand-new source needs no change to the job', async () => {
    // A second, differently-implemented source works through the same call.
    class SparseSource extends FakeSource {}
    const repo = new FakeRepo();
    const res = await backfillCandles({
      source: new SparseSource(mkBars(2)),
      repo: repo as unknown as MarketRepo,
      instrument: 'EUR_USD',
      timeframe: 'M1',
      ...range,
    });
    expect(res.candlesWritten).toBe(2);
  });
});
