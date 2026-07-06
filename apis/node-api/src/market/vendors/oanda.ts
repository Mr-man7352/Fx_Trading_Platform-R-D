import type { Timeframe } from '@fx/types';
import type { CandleRow } from '../repo.js';
import {
  type CandleFetchRequest,
  type CandleSource,
  defaultHttpClient,
  type HttpClient,
} from './types.js';

/**
 * BE-041 — OANDA v20 candles adapter (the first `CandleSource`). Pages the
 * REST candles endpoint (5,000 bars/request cap) ascending from `from`, parsing
 * mid OHLC. Shares its request shape with the Python minimal client (QN-020/021)
 * so both planes speak the same OANDA dialect. Transport is injectable → unit
 * tests need no network.
 */

export interface OandaAdapterOptions {
  apiToken: string;
  /** 'practice' → api-fxpractice, 'live' → api-fxtrade. */
  environment?: 'practice' | 'live';
  http?: HttpClient;
  restHost?: string;
}

const GRANULARITY: Record<Timeframe, string> = {
  M1: 'M1',
  M5: 'M5',
  M15: 'M15',
  M30: 'M30',
  H1: 'H1',
  H4: 'H4',
  D1: 'D',
  W1: 'W',
};

interface OandaCandle {
  time: string;
  volume: number;
  complete: boolean;
  mid?: { o: string; h: string; l: string; c: string };
}

export class OandaCandleSource implements CandleSource {
  readonly name = 'oanda';
  private readonly http: HttpClient;
  private readonly host: string;
  private readonly token: string;

  constructor(opts: OandaAdapterOptions) {
    this.http = opts.http ?? defaultHttpClient;
    this.token = opts.apiToken;
    this.host =
      opts.restHost ??
      (opts.environment === 'live'
        ? 'https://api-fxtrade.oanda.com'
        : 'https://api-fxpractice.oanda.com');
  }

  async *fetchCandles(req: CandleFetchRequest): AsyncGenerator<CandleRow[], void, unknown> {
    const gran = GRANULARITY[req.timeframe];
    let cursor = req.from;
    // Guard against a non-advancing cursor (identical timestamps) looping forever.
    for (let guard = 0; guard < 100_000; guard += 1) {
      if (cursor.getTime() >= req.to.getTime()) return;
      const url =
        `${this.host}/v3/instruments/${encodeURIComponent(req.instrument)}/candles` +
        `?price=M&granularity=${gran}&count=${req.pageSize}` +
        `&from=${encodeURIComponent(cursor.toISOString())}&includeFirst=${guard === 0}`;
      const res = await this.http(url, { headers: { Authorization: `Bearer ${this.token}` } });
      if (!res.ok) {
        throw new Error(`OANDA candles ${req.instrument} ${gran} failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { candles?: OandaCandle[] };
      const raw = body.candles ?? [];
      const page: CandleRow[] = [];
      for (const c of raw) {
        const ts = new Date(c.time);
        if (ts.getTime() >= req.to.getTime()) break;
        if (!c.mid) continue;
        page.push({
          instrument: req.instrument,
          timeframe: req.timeframe,
          ts,
          open: Number(c.mid.o),
          high: Number(c.mid.h),
          low: Number(c.mid.l),
          close: Number(c.mid.c),
          volume: c.volume,
          complete: c.complete,
          source: 'oanda',
        });
      }
      if (page.length > 0) yield page;

      // Advance past the last bar we saw; stop when the page is short (caught up).
      if (raw.length < req.pageSize) return;
      const last = raw.at(-1);
      if (!last) return;
      cursor = new Date(new Date(last.time).getTime() + 1);
      if (cursor.getTime() <= req.from.getTime()) return; // no forward progress
    }
  }
}
