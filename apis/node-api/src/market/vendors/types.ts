import type { Timeframe } from '@fx/types';
import type { CandleRow } from '../repo.js';

/**
 * BE-041 — the pluggable vendor-adapter seam. The backfill job depends ONLY on
 * these interfaces, so a new vendor (Polygon, Massive, …) is added by writing an
 * adapter — no change to `backfillCandles`.
 */

/** Minimal injectable HTTP transport (defaults to global fetch; mocked in tests). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type HttpClient = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<HttpResponse>;

export const defaultHttpClient: HttpClient = (url, init) =>
  fetch(url, init) as unknown as Promise<HttpResponse>;

export interface CandleFetchRequest {
  instrument: string;
  timeframe: Timeframe;
  /** Inclusive lower bound on bar-open time. */
  from: Date;
  /** Exclusive upper bound; adapter stops once bars reach it. */
  to: Date;
  /** Page size cap (OANDA hard limit is 5,000). */
  pageSize: number;
}

/** A primary history source that can be backfilled into TimescaleDB. */
export interface CandleSource {
  readonly name: string;
  /**
   * Yields pages of candles ascending by time. Implementations page internally
   * and MUST stop at `to`. Each page holds ≤ `pageSize` rows.
   */
  fetchCandles(req: CandleFetchRequest): AsyncGenerator<CandleRow[], void, unknown>;
}

/** A secondary source used only to cross-check the primary (QN-021). */
export interface CrossCheckSource {
  readonly name: string;
  /** Sampled mid price for `instrument` at (or just before) `ts`; null if unavailable. */
  sampleMid(instrument: string, timeframe: Timeframe, ts: Date): Promise<number | null>;
}
