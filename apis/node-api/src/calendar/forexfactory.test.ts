import { describe, expect, it } from 'vitest';
import { ForexFactoryVendor, parseForexFactoryFeed } from './forexfactory.js';

/**
 * BE-110 — vendor mapper against the NFP fixture (the AC event: risk gate
 * must block USD entries ±30 min around it; engine coverage lives in
 * @fx/risk-gate engine.test.ts — here we prove the feed maps into the shape
 * that rule consumes).
 */

const NFP_FIXTURE = [
  {
    title: 'Non-Farm Employment Change',
    country: 'USD',
    date: '2026-07-03T08:30:00-04:00',
    impact: 'High',
    forecast: '110K',
    previous: '139K',
  },
  {
    title: 'Bank Holiday',
    country: 'USD',
    date: '2026-07-03T00:00:00-04:00',
    impact: 'Holiday',
    forecast: '',
    previous: '',
  },
  {
    title: 'German Factory Orders m/m',
    country: 'EUR',
    date: '2026-07-06T06:00:00Z',
    impact: 'Medium',
    forecast: '1.2%',
    previous: '-1.4%',
  },
  // malformed rows — skipped, never thrown
  { title: '', country: 'USD', date: '2026-07-03T08:30:00-04:00', impact: 'High' },
  { title: 'Bad date', country: 'USD', date: 'not-a-date', impact: 'High' },
  { title: 'Bad country', country: 'USDX', date: '2026-07-03T08:30:00Z', impact: 'High' },
  'not-an-object',
];

describe('parseForexFactoryFeed (BE-110)', () => {
  it('maps the NFP row with UTC-normalized time, currency, and high impact', () => {
    const events = parseForexFactoryFeed(NFP_FIXTURE);
    const nfp = events.find((e) => e.title === 'Non-Farm Employment Change');
    expect(nfp).toBeDefined();
    expect(nfp?.currency).toBe('USD');
    expect(nfp?.impact).toBe('high');
    // -04:00 offset normalizes to 12:30 UTC
    expect(nfp?.ts.toISOString()).toBe('2026-07-03T12:30:00.000Z');
    expect(nfp?.forecast).toBe('110K');
    expect(nfp?.previous).toBe('139K');
  });

  it('maps Holiday/unknown impact to low (never triggers the blackout rule)', () => {
    const events = parseForexFactoryFeed(NFP_FIXTURE);
    expect(events.find((e) => e.title === 'Bank Holiday')?.impact).toBe('low');
  });

  it('maps Medium impact and skips malformed rows defensively', () => {
    const events = parseForexFactoryFeed(NFP_FIXTURE);
    expect(events.find((e) => e.currency === 'EUR')?.impact).toBe('medium');
    expect(events).toHaveLength(3); // 3 valid, 4 skipped
  });

  it('returns [] on a non-array payload', () => {
    expect(parseForexFactoryFeed({ error: 'nope' })).toEqual([]);
    expect(parseForexFactoryFeed(null)).toEqual([]);
  });
});

describe('ForexFactoryVendor', () => {
  it('fetches + parses via the injected fetch (no network in tests)', async () => {
    const vendor = new ForexFactoryVendor(
      (async () =>
        new Response(JSON.stringify(NFP_FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const events = await vendor.fetchEvents();
    expect(events).toHaveLength(3);
    expect(vendor.name).toBe('forexfactory');
  });

  it('throws on a non-2xx response (refresh logs + degrades, never fabricates)', async () => {
    const vendor = new ForexFactoryVendor(
      (async () => new Response('gone', { status: 503 })) as typeof fetch,
    );
    await expect(vendor.fetchEvents()).rejects.toThrow('HTTP 503');
  });
});
