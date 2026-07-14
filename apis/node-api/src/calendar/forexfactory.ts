import type { CalendarImpact } from '@fx/types';

/**
 * BE-110 — Forex Factory free weekly calendar feed (keyless).
 * Endpoint: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *
 * Feed rows look like:
 *   { "title":"Non-Farm Employment Change", "country":"USD",
 *     "date":"2026-07-03T08:30:00-04:00", "impact":"High",
 *     "forecast":"110K", "previous":"139K" }
 *
 * `country` is already an ISO currency code; `impact` ∈ High|Medium|Low|Holiday.
 * Holidays are kept as LOW-impact rows (they never trigger the blackout rule,
 * which filters on high). Parsing is defensive: a malformed row is skipped,
 * never thrown — a bad vendor payload degrades to fewer events, and staleness
 * (CALENDAR_STALE_AFTER_MS) flips the provider to unavailable = fail-open.
 */

export const FOREX_FACTORY_FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

export interface VendorCalendarEvent {
  ts: Date;
  currency: string;
  impact: CalendarImpact;
  title: string;
  forecast: string | null;
  previous: string | null;
}

export interface CalendarVendor {
  readonly name: string;
  fetchEvents(): Promise<VendorCalendarEvent[]>;
}

function mapImpact(raw: unknown): CalendarImpact {
  const v = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  return 'low'; // Low, Holiday, unknown
}

/** Pure mapper (unit-tested against the NFP fixture). */
export function parseForexFactoryFeed(raw: unknown): VendorCalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: VendorCalendarEvent[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const currency = typeof r.country === 'string' ? r.country.trim().toUpperCase() : '';
    const dateStr = typeof r.date === 'string' ? r.date : '';
    const ts = new Date(dateStr);
    if (!title || currency.length !== 3 || Number.isNaN(ts.getTime())) continue;
    events.push({
      ts,
      currency,
      impact: mapImpact(r.impact),
      title,
      forecast: typeof r.forecast === 'string' && r.forecast !== '' ? r.forecast : null,
      previous: typeof r.previous === 'string' && r.previous !== '' ? r.previous : null,
    });
  }
  return events;
}

export class ForexFactoryVendor implements CalendarVendor {
  readonly name = 'forexfactory';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url: string = FOREX_FACTORY_FEED_URL,
  ) {}

  async fetchEvents(): Promise<VendorCalendarEvent[]> {
    const res = await this.fetchImpl(this.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`forexfactory feed HTTP ${res.status}`);
    }
    return parseForexFactoryFeed(await res.json());
  }
}
