import { describe, expect, it, vi } from 'vitest';
import type { CandleRow } from '../repo.js';
import { OandaCandleSource } from './oanda.js';
import type { HttpClient, HttpResponse } from './types.js';

const ok = (body: unknown): HttpResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const oandaCandle = (time: string, c: number, complete = true) => ({
  time,
  volume: 10,
  complete,
  // Fixed-decimal strings (like OANDA) so parsing yields exact 1.081 / 1.079.
  mid: { o: c.toFixed(5), h: (c + 0.001).toFixed(5), l: (c - 0.001).toFixed(5), c: c.toFixed(5) },
});

async function collect(source: OandaCandleSource, from: Date, to: Date): Promise<CandleRow[]> {
  const rows: CandleRow[] = [];
  for await (const page of source.fetchCandles({
    instrument: 'EUR_USD',
    timeframe: 'M1',
    from,
    to,
    pageSize: 2,
  })) {
    rows.push(...page);
  }
  return rows;
}

describe('OandaCandleSource', () => {
  it('pages ascending, parses mid OHLC and stops at `to`', async () => {
    const http = vi.fn<HttpClient>(async (url) => {
      if (url.includes('includeFirst=true')) {
        return ok({
          candles: [
            oandaCandle('2026-03-10T14:00:00.000000000Z', 1.08),
            oandaCandle('2026-03-10T14:01:00.000000000Z', 1.081),
          ],
        });
      }
      return ok({ candles: [oandaCandle('2026-03-10T14:02:00.000000000Z', 1.082)] });
    });
    const source = new OandaCandleSource({ apiToken: 't', http });

    const rows = await collect(source, new Date('2026-03-10T14:00:00Z'), new Date('2026-03-10T15:00:00Z'));

    expect(rows.map((r) => r.ts.toISOString())).toEqual([
      '2026-03-10T14:00:00.000Z',
      '2026-03-10T14:01:00.000Z',
      '2026-03-10T14:02:00.000Z',
    ]);
    expect(rows[0]).toMatchObject({ open: 1.08, high: 1.081, low: 1.079, close: 1.08, source: 'oanda' });
    // Bearer auth + first page uses includeFirst=true.
    expect(http.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer t');
  });

  it('excludes bars at/after `to`', async () => {
    const http: HttpClient = async () =>
      ok({
        candles: [
          oandaCandle('2026-03-10T14:00:00Z', 1.08),
          oandaCandle('2026-03-10T14:05:00Z', 1.09), // == to → excluded
        ],
      });
    const source = new OandaCandleSource({ apiToken: 't', http });
    const rows = await collect(source, new Date('2026-03-10T14:00:00Z'), new Date('2026-03-10T14:05:00Z'));
    expect(rows).toHaveLength(1);
  });

  it('throws on a non-2xx response', async () => {
    const http: HttpClient = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    });
    const source = new OandaCandleSource({ apiToken: 'bad', http });
    await expect(collect(source, new Date('2026-03-10T14:00:00Z'), new Date('2026-03-10T15:00:00Z'))).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('targets the practice host by default', () => {
    const source = new OandaCandleSource({ apiToken: 't' });
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for host assertion.
    expect((source as any).host).toBe('https://api-fxpractice.oanda.com');
  });
});
