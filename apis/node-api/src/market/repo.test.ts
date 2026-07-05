import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db.js';
import { cotReleaseTs } from './macro.js';
import { MarketRepo, newsDedupeKey } from './repo.js';

/**
 * In-memory Prisma stand-in supporting exactly the query shapes MarketRepo
 * issues for news + macro. Lets us assert the BE-042/BE-043 no-look-ahead
 * guarantees without a database.
 */
function fakePrisma() {
  const news: Record<string, unknown>[] = [];
  const macro: Record<string, unknown>[] = [];
  let seq = 0;
  return {
    _news: news,
    newsItem: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        news.find((n) =>
          Object.entries(where).every(([k, v]) =>
            k === 'publishedAt' ? (n[k] as Date).getTime() === (v as Date).getTime() : n[k] === v,
          ),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n${seq++}`, ...data };
        news.push(row);
        return row;
      },
      findMany: async ({
        where = {},
        take,
      }: {
        where?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        let rows = news.filter((n) => matchNews(n, where));
        rows = rows.sort(
          (a, b) => (b.publishedAt as Date).getTime() - (a.publishedAt as Date).getTime(),
        );
        return take ? rows.slice(0, take) : rows;
      },
    },
    macroFeature: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { series_releaseTs_revision: { series: string; releaseTs: Date; revision: number } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const k = where.series_releaseTs_revision;
        const found = macro.find(
          (m) =>
            m.series === k.series &&
            (m.releaseTs as Date).getTime() === k.releaseTs.getTime() &&
            m.revision === k.revision,
        );
        if (found) Object.assign(found, update);
        else macro.push({ ...create });
        return {};
      },
      findMany: async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) => {
        let rows = macro.filter((m) => {
          if (where.series && m.series !== where.series) return false;
          const rel = where.releaseTs as { lte?: Date } | undefined;
          if (rel?.lte && (m.releaseTs as Date).getTime() > rel.lte.getTime()) return false;
          return true;
        });
        rows = rows.sort((a, b) => (b.releaseTs as Date).getTime() - (a.releaseTs as Date).getTime());
        return take ? rows.slice(0, take) : rows;
      },
    },
  };
}

function matchNews(n: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'publishedAt') {
      const bound = v as { lte?: Date; gte?: Date };
      const t = (n.publishedAt as Date).getTime();
      if (bound.lte && t > bound.lte.getTime()) return false;
      if (bound.gte && t < bound.gte.getTime()) return false;
    } else if (k === 'instruments') {
      const has = (v as { has: string }).has;
      if (!(n.instruments as string[]).includes(has)) return false;
    } else if (n[k] !== v) {
      return false;
    }
  }
  return true;
}

const iso = (s: string) => new Date(s);

describe('newsDedupeKey', () => {
  it('keys on externalId when present, else headline+time', () => {
    expect(newsDedupeKey({ source: 'x', externalId: 'abc', headline: 'h', publishedAt: iso('2026-03-10T00:00:00Z') })).toBe(
      'x::abc',
    );
    expect(newsDedupeKey({ source: 'x', externalId: null, headline: 'h', publishedAt: iso('2026-03-10T00:00:00Z') })).toBe(
      'x::h@2026-03-10T00:00:00.000Z',
    );
  });
});

describe('MarketRepo news (BE-042)', () => {
  it('collapses duplicates on ingest', async () => {
    const p = fakePrisma();
    const repo = new MarketRepo(p as unknown as PrismaClient);
    const item = {
      publishedAt: iso('2026-03-10T12:00:00Z'),
      source: 'reuters',
      externalId: 'evt-1',
      headline: 'ECB holds rates',
      instruments: ['EUR_USD'],
    };
    const first = await repo.ingestNews([item]);
    const second = await repo.ingestNews([item, { ...item, externalId: 'evt-2', headline: 'Fed minutes' }]);
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 1, skipped: 1 });
    expect(p._news).toHaveLength(2);
  });

  it('point-in-time query never returns news published after the cutoff', async () => {
    const p = fakePrisma();
    const repo = new MarketRepo(p as unknown as PrismaClient);
    await repo.ingestNews([
      { publishedAt: iso('2026-03-10T09:00:00Z'), source: 's', externalId: 'a', headline: 'before', instruments: ['EUR_USD'] },
      { publishedAt: iso('2026-03-10T11:00:00Z'), source: 's', externalId: 'b', headline: 'after', instruments: ['EUR_USD'] },
    ]);
    const barTs = iso('2026-03-10T10:00:00Z');
    const visible = await repo.queryNews({ asOf: barTs, limit: 50 });
    expect(visible.map((n) => n.headline)).toEqual(['before']);
    // The future headline is invisible at the bar timestamp — no look-ahead.
    expect(visible.some((n) => n.headline === 'after')).toBe(false);
  });

  it('filters by instrument', async () => {
    const p = fakePrisma();
    const repo = new MarketRepo(p as unknown as PrismaClient);
    await repo.ingestNews([
      { publishedAt: iso('2026-03-10T09:00:00Z'), source: 's', externalId: 'a', headline: 'eur', instruments: ['EUR_USD'] },
      { publishedAt: iso('2026-03-10T09:00:00Z'), source: 's', externalId: 'b', headline: 'gold', instruments: ['XAU_USD'] },
    ]);
    const rows = await repo.queryNews({ instrument: 'XAU_USD', limit: 50 });
    expect(rows.map((n) => n.headline)).toEqual(['gold']);
  });
});

describe('MarketRepo macro (BE-043 no look-ahead)', () => {
  it('COT is only visible after its Friday release, not its Tuesday reference', async () => {
    const p = fakePrisma();
    const repo = new MarketRepo(p as unknown as PrismaClient);
    const referenceTuesday = iso('2026-03-10T00:00:00Z'); // a Tuesday
    const release = cotReleaseTs(referenceTuesday);
    expect(release.getUTCDay()).toBe(5); // Friday
    await repo.upsertMacro([
      { series: 'COT_EUR_NET', releaseTs: release, value: 12345, source: 'cftc', period: '2026-03-10' },
    ]);

    // Querying as-of Wednesday (after the reference date, before the release): invisible.
    const wed = await repo.queryMacro({ series: 'COT_EUR_NET', asOf: iso('2026-03-11T12:00:00Z'), limit: 10 });
    expect(wed).toHaveLength(0);
    // As-of the following Monday (after release): visible.
    const mon = await repo.queryMacro({ series: 'COT_EUR_NET', asOf: iso('2026-03-16T12:00:00Z'), limit: 10 });
    expect(mon).toHaveLength(1);
    expect(mon[0]?.value).toBe(12345);
  });

  it('upsert is idempotent on series×release×revision', async () => {
    const p = fakePrisma();
    const repo = new MarketRepo(p as unknown as PrismaClient);
    const row = { series: 'DGS10', releaseTs: iso('2026-03-10T00:00:00Z'), value: 4.2, source: 'fred' };
    await repo.upsertMacro([row]);
    await repo.upsertMacro([{ ...row, value: 4.3 }]); // same key → update, not insert
    const rows = await repo.queryMacro({ series: 'DGS10', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(4.3);
  });
});
