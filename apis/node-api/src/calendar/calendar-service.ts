import type { EconomicEvent } from '@fx/risk-gate';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import type { CalendarProvider } from '../signals/risk-gate.js';
import type { CalendarVendor } from './forexfactory.js';
import { ForexFactoryVendor } from './forexfactory.js';

/**
 * BE-110 — economic calendar service: vendor refresh into `calendar_events`
 * and the `DbCalendarProvider` that finally closes the `CalendarProvider`
 * seam left open since Phase 3 (risk-gate econ-blackout rule + supervision
 * `pre_news_flatten`, which have been recording `calendar_unavailable`).
 *
 * Availability semantics (fail-open, per the Phase-3 contract):
 *   available() == true ONLY when the latest successful refresh is younger
 *   than CALENDAR_STALE_AFTER_MS. A dead vendor, empty table, or stale data
 *   flips the provider back to unavailable — the blackout rule then records
 *   `calendar_unavailable` and passes, exactly as before BE-110.
 */

export function buildCalendarVendor(env: Env): CalendarVendor | null {
  if (env.CALENDAR_PROVIDER === 'forexfactory') return new ForexFactoryVendor();
  return null;
}

/** Upsert vendor events on the (source, ts, currency, title) natural key. */
export async function refreshCalendar(
  prisma: PrismaClient,
  vendor: CalendarVendor,
): Promise<{ fetched: number; written: number }> {
  const events = await vendor.fetchEvents();
  let written = 0;
  const fetchedAt = new Date();
  for (const ev of events) {
    await prisma.economicCalendarEvent.upsert({
      where: {
        source_ts_currency_title: {
          source: vendor.name,
          ts: ev.ts,
          currency: ev.currency,
          title: ev.title,
        },
      },
      create: {
        source: vendor.name,
        ts: ev.ts,
        currency: ev.currency,
        impact: ev.impact,
        title: ev.title,
        forecast: ev.forecast,
        previous: ev.previous,
        fetchedAt,
      },
      update: {
        impact: ev.impact,
        forecast: ev.forecast,
        previous: ev.previous,
        fetchedAt,
      },
    });
    written += 1;
  }
  return { fetched: events.length, written };
}

/** Latest successful fetch time (null = never refreshed). */
export async function lastCalendarFetch(prisma: PrismaClient): Promise<Date | null> {
  const row = await prisma.economicCalendarEvent.findFirst({
    orderBy: { fetchedAt: 'desc' },
    select: { fetchedAt: true },
  });
  return row?.fetchedAt ?? null;
}

export class DbCalendarProvider implements CalendarProvider {
  private availableFlag = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly staleAfterMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Sync read of the last hydrated state (CalendarProvider contract). */
  available(): boolean {
    return this.availableFlag;
  }

  /** Re-check freshness against the DB; call on boot + on a timer. */
  async hydrate(): Promise<boolean> {
    try {
      const last = await lastCalendarFetch(this.prisma);
      this.availableFlag =
        last !== null && this.now().getTime() - last.getTime() < this.staleAfterMs;
    } catch (err) {
      console.warn('[calendar] hydrate failed — provider reports unavailable:', err);
      this.availableFlag = false;
    }
    return this.availableFlag;
  }

  async eventsAround(barTs: Date, windowMinutes: number): Promise<EconomicEvent[]> {
    const windowMs = windowMinutes * 60_000;
    const rows = await this.prisma.economicCalendarEvent.findMany({
      where: {
        ts: {
          gte: new Date(barTs.getTime() - windowMs),
          lte: new Date(barTs.getTime() + windowMs),
        },
      },
      orderBy: { ts: 'asc' },
    });
    return rows.map((r) => ({
      ts: r.ts,
      impact: (['high', 'medium', 'low'].includes(r.impact) ? r.impact : 'low') as
        | 'high'
        | 'medium'
        | 'low',
      currencies: [r.currency],
    }));
  }
}

/**
 * Boot helper for workers: builds the provider, hydrates now, and re-hydrates
 * on an interval so availability tracks refresh recency without a DB hit per
 * gate evaluation. Returns null when CALENDAR_PROVIDER=none AND the table has
 * never been refreshed manually (provider still works off old data if present).
 */
export function startCalendarProvider(
  prisma: PrismaClient,
  env: Env,
  rehydrateEveryMs = 5 * 60_000,
): { provider: DbCalendarProvider; stop(): void } {
  const provider = new DbCalendarProvider(prisma, env.CALENDAR_STALE_AFTER_MS);
  provider.hydrate().catch(() => {});
  const timer = setInterval(() => {
    provider.hydrate().catch(() => {});
  }, rehydrateEveryMs);
  timer.unref();
  return { provider, stop: () => clearInterval(timer) };
}
