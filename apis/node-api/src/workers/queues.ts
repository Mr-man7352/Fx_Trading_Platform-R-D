/**
 * Step 1.6 — shared queue names + job payloads for the market-data pipeline.
 * QN-020's OANDA stream (Python) publishes ticks to `market-ticks`; BE-040's
 * worker aggregates them and, on each H1 close, enqueues a `signals` job that
 * the Phase-3 signals worker (BE-066) consumes.
 */
export const MARKET_TICKS_QUEUE = 'market-ticks';
export const SIGNALS_QUEUE = 'signals';

/** Redis pub/sub channel the data-quality monitor publishes flags to. */
export const DATA_QUALITY_CHANNEL = 'data-quality:flags';

export interface TickJob {
  instrument: string;
  /** ISO-8601 tick time (UTC). */
  ts: string;
  bid: number;
  ask: number;
}

export interface SignalJob {
  instrument: string;
  timeframe: string;
  /** ISO-8601 bar-open time of the closed bar that triggered the signal. */
  barTs: string;
}
