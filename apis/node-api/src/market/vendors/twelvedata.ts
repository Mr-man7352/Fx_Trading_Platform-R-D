import type { Timeframe } from '@fx/types';
import { getInstrument } from '../instruments.js';
import {
  type CrossCheckSource,
  defaultHttpClient,
  type HttpClient,
} from './types.js';

/**
 * BE-041/QN-021 — Twelve Data free-tier cross-check source. Used only to
 * sample-verify OANDA candles, never as a primary feed (rate-limited free tier).
 * Returns null for instruments without a Twelve Data mapping (e.g. energy CFDs).
 */

export interface TwelveDataOptions {
  apiKey: string;
  http?: HttpClient;
  host?: string;
}

const INTERVAL: Record<Timeframe, string> = {
  M1: '1min',
  M5: '5min',
  M15: '15min',
  M30: '30min',
  H1: '1h',
  H4: '4h',
  D1: '1day',
  W1: '1week',
};

interface TdValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

export class TwelveDataCrossCheck implements CrossCheckSource {
  readonly name = 'twelvedata';
  private readonly http: HttpClient;
  private readonly host: string;
  private readonly key: string;

  constructor(opts: TwelveDataOptions) {
    this.http = opts.http ?? defaultHttpClient;
    this.key = opts.apiKey;
    this.host = opts.host ?? 'https://api.twelvedata.com';
  }

  async sampleMid(instrument: string, timeframe: Timeframe, ts: Date): Promise<number | null> {
    const symbol = getInstrument(instrument)?.twelveDataSymbol;
    if (!symbol) return null; // unsupported on Twelve Data — skip cross-check
    const url =
      `${this.host}/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${INTERVAL[timeframe]}&outputsize=1&format=JSON` +
      `&end_date=${encodeURIComponent(ts.toISOString())}&apikey=${encodeURIComponent(this.key)}`;
    const res = await this.http(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; values?: TdValue[] };
    const v = body.values?.[0];
    if (!v) return null;
    // Cross-check on the close (mid proxy) — Twelve Data returns mid-market FX.
    return Number(v.close);
  }
}
