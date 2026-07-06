import { describe, expect, it, vi } from 'vitest';
import { DataQualityMonitor } from './data-quality.js';
import { MarketDataProcessor, type SignalTrigger } from './processor.js';
import type { CandleRow, MarketRepo } from './repo.js';

class FakeRepo {
  bars: CandleRow[] = [];
  async upsertCandles(rows: CandleRow[]): Promise<number> {
    this.bars.push(...rows);
    return rows.length;
  }
}

function setup() {
  const repo = new FakeRepo();
  const monitor = new DataQualityMonitor({ record: () => {} });
  const triggers: SignalTrigger[] = [];
  const proc = new MarketDataProcessor(repo as unknown as MarketRepo, monitor, (t) => {
    triggers.push(t);
  });
  return { repo, monitor, triggers, proc };
}

const tick = (iso: string, mid: number) => ({
  ts: new Date(iso),
  bid: mid - 0.00005,
  ask: mid + 0.00005,
});

describe('MarketDataProcessor (BE-040)', () => {
  it('aggregates ticks into M1 bars and persists on close', async () => {
    const { repo, proc } = setup();
    await proc.onTick('EUR_USD', tick('2026-03-10T14:00:30Z', 1.08));
    await proc.onTick('EUR_USD', tick('2026-03-10T14:01:30Z', 1.081)); // closes 14:00
    expect(repo.bars).toHaveLength(1);
    expect(repo.bars[0]).toMatchObject({
      instrument: 'EUR_USD',
      timeframe: 'M1',
      complete: true,
    });
    expect(repo.bars[0]?.ts.toISOString()).toBe('2026-03-10T14:00:00.000Z');
  });

  it('enqueues exactly one H1 signal when the H1 bar finalises', async () => {
    const { triggers, proc } = setup();
    await proc.onTick('EUR_USD', tick('2026-03-10T14:00:30Z', 1.08));
    await proc.onTick('EUR_USD', tick('2026-03-10T15:00:10Z', 1.082)); // closes 14:00 M1 (H1=14:00)
    expect(triggers).toHaveLength(0); // H1 14:00 not yet final
    await proc.onTick('EUR_USD', tick('2026-03-10T15:01:10Z', 1.083)); // closes 15:00 M1 → H1 advances
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ instrument: 'EUR_USD', timeframe: 'H1' });
    expect(triggers[0]?.barTs.toISOString()).toBe('2026-03-10T14:00:00.000Z');
  });

  it('flush persists the open bar', async () => {
    const { repo, proc } = setup();
    await proc.onTick('EUR_USD', tick('2026-03-10T14:00:30Z', 1.08));
    await proc.flush('EUR_USD');
    expect(repo.bars).toHaveLength(1);
  });

  it('surfaces a stale feed through the monitor', async () => {
    const { monitor, proc } = setup();
    const spy = vi.spyOn(monitor, 'checkStale');
    await proc.onTick('EUR_USD', tick('2026-03-10T14:00:30Z', 1.08));
    proc.checkStale(new Date('2026-03-10T14:01:20Z'));
    expect(spy).toHaveBeenCalledOnce();
    expect(monitor.isDegraded('EUR_USD')).toBe(true); // >30s since the only tick
  });
});
