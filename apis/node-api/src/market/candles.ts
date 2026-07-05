import type { Candle, Timeframe } from '@fx/types';

/**
 * BE-040 — deterministic tick→candle aggregation. Pure and DB-free so it is
 * unit-testable in isolation; the BullMQ worker (workers/market-data.ts) wires
 * a live/mock feed into it and persists closed bars via the repo.
 *
 * Base ingest is M1 (schema.prisma); M5…D1 are served from TimescaleDB
 * continuous aggregates, so the worker only ever aggregates to M1 and lets the
 * CAGGs roll higher timeframes.
 */

/** Bar length in milliseconds for sub-day timeframes (divide evenly into 24h). */
const TIMEFRAME_MS: Partial<Record<Timeframe, number>> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * UTC bar-open time for `ts` at `tf`. Sub-day frames use epoch modulo (epoch 0
 * is 00:00 UTC, and every sub-day frame divides 24h, so buckets stay aligned).
 * D1 closes at 00:00 UTC (DEVLOG: not NY 17:00 yet); W1 anchors to Monday.
 */
export function bucketStart(ts: Date, tf: Timeframe): Date {
  const ms = ts.getTime();
  const span = TIMEFRAME_MS[tf];
  if (span !== undefined) {
    return new Date(ms - (((ms % span) + span) % span));
  }
  if (tf === 'D1') {
    return new Date(ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS));
  }
  // W1 — floor to the most recent Monday 00:00 UTC.
  const day = new Date(ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS));
  const dow = day.getUTCDay(); // 0=Sun … 1=Mon
  const backToMonday = (dow + 6) % 7;
  return new Date(day.getTime() - backToMonday * DAY_MS);
}

/** Start of the bar immediately after the one containing `ts`. */
export function nextBucketStart(ts: Date, tf: Timeframe): Date {
  const start = bucketStart(ts, tf);
  if (tf === 'W1') return new Date(start.getTime() + 7 * DAY_MS);
  const span = TIMEFRAME_MS[tf] ?? DAY_MS;
  return new Date(start.getTime() + span);
}

/** A price observation. `mid` is `(bid + ask) / 2`; `volume` defaults to 1 tick. */
export interface Tick {
  ts: Date;
  mid: number;
  volume?: number;
}

interface OpenBar {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Streams ticks into candles for one instrument × timeframe. Ticks MUST arrive
 * in non-decreasing timestamp order (the feed guarantees this per connection);
 * an out-of-order tick older than the open bar is dropped rather than
 * corrupting OHLC.
 */
export class CandleAggregator {
  private open: OpenBar | null = null;

  constructor(
    private readonly instrument: string,
    private readonly timeframe: Timeframe = 'M1',
    private readonly source = 'oanda',
  ) {}

  /**
   * Feed one tick. Returns every bar that closed as a result (usually zero or
   * one; more if the tick jumped several empty buckets — those are skipped, not
   * synthesised, so gaps stay visible to the data-quality monitor).
   */
  add(tick: Tick): Candle[] {
    const bucket = bucketStart(tick.ts, this.timeframe);
    const closed: Candle[] = [];

    if (this.open && bucket.getTime() > this.open.ts.getTime()) {
      closed.push(this.finalize(this.open));
      this.open = null;
    }

    if (this.open && tick.ts.getTime() < this.open.ts.getTime()) {
      return closed; // stale out-of-order tick — ignore
    }

    if (!this.open) {
      this.open = {
        ts: bucket,
        open: tick.mid,
        high: tick.mid,
        low: tick.mid,
        close: tick.mid,
        volume: tick.volume ?? 1,
      };
      return closed;
    }

    this.open.high = Math.max(this.open.high, tick.mid);
    this.open.low = Math.min(this.open.low, tick.mid);
    this.open.close = tick.mid;
    this.open.volume += tick.volume ?? 1;
    return closed;
  }

  /** The still-forming bar (`complete=false`), or null when idle. */
  snapshot(): Candle | null {
    return this.open ? this.finalize(this.open, false) : null;
  }

  /** Force-close the open bar (shutdown / feed reset). Returns it if present. */
  flush(): Candle | null {
    if (!this.open) return null;
    const bar = this.finalize(this.open);
    this.open = null;
    return bar;
  }

  private finalize(bar: OpenBar, complete = true): Candle {
    return {
      instrument: this.instrument,
      timeframe: this.timeframe,
      ts: bar.ts.toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      complete,
      source: this.source,
    };
  }
}
