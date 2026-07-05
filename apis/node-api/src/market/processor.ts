import type { Candle, Timeframe } from '@fx/types';
import { bucketStart, CandleAggregator } from './candles.js';
import type { DataQualityMonitor } from './data-quality.js';
import type { MarketRepo } from './repo.js';

/**
 * BE-040 — pure ingest orchestration: ticks → M1 candles → TimescaleDB, with a
 * signal job enqueued on every H1 close (the H1 swing cycle). Kept DB/Redis-
 * free at the seams (repo + enqueue callback are injected) so it unit-tests
 * without infrastructure; the BullMQ worker (workers/market-data.ts) wires the
 * real repo, EventBus sink and `signals` queue into it.
 *
 * Only M1 is written here; M5…D1 come from TimescaleDB continuous aggregates,
 * so "H1 candle within one bar period" (acceptance) is satisfied by the CAGG,
 * while the H1-close signal job is emitted from the M1 stream crossing an H1
 * boundary.
 */
export interface RawTick {
  ts: Date;
  bid: number;
  ask: number;
}

export interface SignalTrigger {
  instrument: string;
  timeframe: Timeframe;
  /** Bar-open time of the just-closed H1 bar. */
  barTs: Date;
}

export type SignalEnqueue = (trigger: SignalTrigger) => Promise<void> | void;

export class MarketDataProcessor {
  private readonly aggregators = new Map<string, CandleAggregator>();
  private readonly lastH1 = new Map<string, number>();

  constructor(
    private readonly repo: MarketRepo,
    private readonly monitor: DataQualityMonitor,
    private readonly enqueueSignal: SignalEnqueue,
  ) {}

  /** Handle one tick for an instrument: aggregate, persist closes, enqueue H1. */
  async onTick(instrument: string, tick: RawTick): Promise<void> {
    const mid = (tick.bid + tick.ask) / 2;
    this.monitor.observeTick(instrument, tick.ts, tick.bid, tick.ask);

    const agg = this.getAggregator(instrument);
    const closed = agg.add({ ts: tick.ts, mid });
    for (const bar of closed) {
      await this.persistClosed(instrument, bar);
    }
  }

  /** Flush the open M1 bar (feed reset / shutdown), persisting it as complete. */
  async flush(instrument: string): Promise<void> {
    const bar = this.aggregators.get(instrument)?.flush();
    if (bar) await this.persistClosed(instrument, bar);
  }

  /** Periodic stale-feed sweep (the worker calls this on a timer). */
  checkStale(now: Date): void {
    this.monitor.checkStale(now);
  }

  private async persistClosed(instrument: string, bar: Candle): Promise<void> {
    const barTs = new Date(bar.ts);
    await this.repo.upsertCandles([
      {
        instrument: bar.instrument,
        timeframe: bar.timeframe,
        ts: barTs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        complete: true,
        source: bar.source,
      },
    ]);
    this.monitor.observeBar(instrument, 'M1', barTs);
    await this.maybeEnqueueH1(instrument, barTs);
  }

  /**
   * When a closed M1 bar belongs to a later H1 bucket than the last one we saw,
   * the previous H1 bar is now final → enqueue its signal job exactly once.
   */
  private async maybeEnqueueH1(instrument: string, m1BarTs: Date): Promise<void> {
    const h1 = bucketStart(m1BarTs, 'H1').getTime();
    const prev = this.lastH1.get(instrument);
    this.lastH1.set(instrument, h1);
    if (prev !== undefined && h1 > prev) {
      await this.enqueueSignal({ instrument, timeframe: 'H1', barTs: new Date(prev) });
    }
  }

  private getAggregator(instrument: string): CandleAggregator {
    let agg = this.aggregators.get(instrument);
    if (!agg) {
      agg = new CandleAggregator(instrument, 'M1');
      this.aggregators.set(instrument, agg);
    }
    return agg;
  }
}
