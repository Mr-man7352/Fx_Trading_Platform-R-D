import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db.js';
import { DbCalendarProvider, refreshCalendar } from './calendar-service.js';
import type { CalendarVendor } from './forexfactory.js';

/**
 * BE-110 — provider availability semantics (fail-open) + refresh upserts,
 * against an in-memory fake of the `calendar_events` Prisma delegate.
 */

interface Row {
  id: string;
  ts: Date;
  currency: string;
  impact: string;
  title: string;
  source: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  fetchedAt: Date;
}

interface UpsertArgs {
  where: {
    source_ts_currency_title: { source: string; ts: Date; currency: string; title: string };
  };
  create: Omit<Row, 'id' | 'actual'>;
  update: Partial<Row>;
}

function fakePrisma(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  const prisma = {
    economicCalendarEvent: {
      async upsert({ where, create, update }: UpsertArgs) {
        const w = where.source_ts_currency_title;
        const existing = rows.find(
          (r) =>
            r.source === w.source &&
            r.ts.getTime() === w.ts.getTime() &&
            r.currency === w.currency &&
            r.title === w.title,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: Row = { id: `id-${rows.length}`, actual: null, ...create };
        rows.push(row);
        return row;
      },
      async findFirst(args: { orderBy?: { fetchedAt?: string } } = {}) {
        if (rows.length === 0) return null;
        if (args.orderBy?.fetchedAt === 'desc') {
          return [...rows].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];
        }
        return rows[0];
      },
      async findMany(args: { where?: { ts?: { gte?: Date; lte?: Date; lt?: Date } } } = {}) {
        const w = args.where;
        return rows
          .filter((r) => {
            if (w?.ts?.gte && r.ts < w.ts.gte) return false;
            if (w?.ts?.lte && r.ts > w.ts.lte) return false;
            if (w?.ts?.lt && r.ts >= w.ts.lt) return false;
            return true;
          })
          .sort((a, b) => a.ts.getTime() - b.ts.getTime());
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

const NFP_TS = new Date('2026-07-03T12:30:00Z');

function vendorWith(events: Array<{ ts: Date; currency: string; title: string }>): CalendarVendor {
  return {
    name: 'forexfactory',
    async fetchEvents() {
      return events.map((e) => ({
        ...e,
        impact: 'high' as const,
        forecast: null,
        previous: null,
      }));
    },
  };
}

describe('refreshCalendar (BE-110)', () => {
  it('inserts new events and upserts revisions in place (no duplicates)', async () => {
    const { prisma, rows } = fakePrisma();
    const vendor = vendorWith([{ ts: NFP_TS, currency: 'USD', title: 'NFP' }]);
    await refreshCalendar(prisma, vendor);
    await refreshCalendar(prisma, vendor); // second refresh — same natural key
    expect(rows).toHaveLength(1);
  });
});

describe('DbCalendarProvider (fail-open availability)', () => {
  it('reports unavailable before any refresh (blackout rule passes as before)', async () => {
    const { prisma } = fakePrisma();
    const provider = new DbCalendarProvider(prisma, 48 * 3_600_000);
    await provider.hydrate();
    expect(provider.available()).toBe(false);
  });

  it('reports available with fresh data, unavailable once stale', async () => {
    let now = new Date('2026-07-03T00:00:00Z');
    const { prisma } = fakePrisma([
      {
        id: 'e1',
        ts: NFP_TS,
        currency: 'USD',
        impact: 'high',
        title: 'NFP',
        source: 'forexfactory',
        forecast: null,
        previous: null,
        actual: null,
        fetchedAt: new Date('2026-07-02T23:00:00Z'),
      },
    ]);
    const provider = new DbCalendarProvider(prisma, 48 * 3_600_000, () => now);
    expect(await provider.hydrate()).toBe(true);

    now = new Date('2026-07-05T23:30:00Z'); // > 48h after fetch
    expect(await provider.hydrate()).toBe(false); // fail-open: stale ⇒ unavailable
  });

  it('eventsAround returns ±window events shaped for the risk-gate engine', async () => {
    const { prisma } = fakePrisma([
      {
        id: 'e1',
        ts: NFP_TS,
        currency: 'USD',
        impact: 'high',
        title: 'NFP',
        source: 'forexfactory',
        forecast: null,
        previous: null,
        actual: null,
        fetchedAt: new Date(),
      },
      {
        id: 'e2',
        ts: new Date('2026-07-03T18:00:00Z'), // outside ±30 min
        currency: 'EUR',
        impact: 'high',
        title: 'Far away',
        source: 'forexfactory',
        forecast: null,
        previous: null,
        actual: null,
        fetchedAt: new Date(),
      },
    ]);
    const provider = new DbCalendarProvider(prisma, 48 * 3_600_000);
    // bar 12:45 UTC — NFP at 12:30 is inside the ±30 min blackout
    const events = await provider.eventsAround(new Date('2026-07-03T12:45:00Z'), 30);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ ts: NFP_TS, impact: 'high', currencies: ['USD'] });
  });
});
