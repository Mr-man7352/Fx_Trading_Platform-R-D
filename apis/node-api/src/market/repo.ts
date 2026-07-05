import type { Candle, MacroFeature, NewsItem, Timeframe } from '@fx/types';
import type { PrismaClient } from '../db.js';

/**
 * Step 1.6 — persistence for market data over the Prisma client (Step 1.4
 * schema). All writes are idempotent (upsert on the natural PK) so backfills
 * (QN-021/BE-041) and worker restarts never duplicate rows. Point-in-time
 * reads (candles by bar-open, news by published_at) power BE-042/BE-045.
 */

export interface CandleRow {
  instrument: string;
  timeframe: Timeframe;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete?: boolean;
  source?: string;
}

export interface NewsIngestItem {
  publishedAt: Date;
  source: string;
  externalId?: string | null;
  headline: string;
  summary?: string | null;
  url?: string | null;
  instruments?: string[];
  sentiment?: number | null;
  raw?: unknown;
}

export interface MacroIngestItem {
  series: string;
  releaseTs: Date;
  revision?: number;
  period?: string | null;
  value: number;
  source: string;
  raw?: unknown;
}

/** Stable identity for de-duplication (BE-042: "duplicates collapsed"). */
export function newsDedupeKey(item: {
  source: string;
  externalId?: string | null;
  headline: string;
  publishedAt: Date;
}): string {
  const disambiguator = item.externalId?.trim() || `${item.headline}@${item.publishedAt.toISOString()}`;
  return `${item.source}::${disambiguator}`;
}

export class MarketRepo {
  constructor(private readonly prisma: PrismaClient) {}

  /** Idempotent bulk upsert of candles (natural PK: instrument×timeframe×ts). */
  async upsertCandles(rows: CandleRow[]): Promise<number> {
    let written = 0;
    for (const r of rows) {
      const data = {
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        complete: r.complete ?? true,
        source: r.source ?? 'oanda',
      };
      await this.prisma.candle.upsert({
        where: {
          instrument_timeframe_ts: { instrument: r.instrument, timeframe: r.timeframe, ts: r.ts },
        },
        create: { instrument: r.instrument, timeframe: r.timeframe, ts: r.ts, ...data },
        update: data,
      });
      written += 1;
    }
    return written;
  }

  /** Bar-open range read (inclusive `from`, exclusive `to`), ascending. */
  async getCandles(params: {
    instrument: string;
    timeframe: Timeframe;
    from?: Date;
    to?: Date;
    limit: number;
    includeIncomplete: boolean;
  }): Promise<Candle[]> {
    const rows = await this.prisma.candle.findMany({
      where: {
        instrument: params.instrument,
        timeframe: params.timeframe,
        ...(params.includeIncomplete ? {} : { complete: true }),
        ...(params.from || params.to
          ? { ts: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lt: params.to } : {}) } }
          : {}),
      },
      orderBy: { ts: 'asc' },
      take: params.limit,
    });
    return rows.map((r) => ({
      instrument: r.instrument,
      timeframe: r.timeframe as Timeframe,
      ts: r.ts.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      complete: r.complete,
      source: r.source,
    }));
  }

  /**
   * BE-042 — ingest news, collapsing duplicates by {source, externalId|headline}.
   * Returns counts; existing rows are left untouched (published_at is immutable).
   */
  async ingestNews(items: NewsIngestItem[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      const existing = await this.prisma.newsItem.findFirst({
        where: {
          source: item.source,
          ...(item.externalId
            ? { externalId: item.externalId }
            : { headline: item.headline, publishedAt: item.publishedAt }),
        },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      await this.prisma.newsItem.create({
        data: {
          publishedAt: item.publishedAt,
          source: item.source,
          externalId: item.externalId ?? null,
          headline: item.headline,
          summary: item.summary ?? null,
          url: item.url ?? null,
          instruments: item.instruments ?? [],
          sentiment: item.sentiment ?? null,
          raw: (item.raw ?? undefined) as never,
        },
      });
      inserted += 1;
    }
    return { inserted, skipped };
  }

  /**
   * BE-042 — point-in-time news read. `asOf` enforces `published_at <= asOf`
   * (the no-look-ahead guarantee); most-recent-first, capped at `limit`.
   */
  async queryNews(params: {
    instrument?: string;
    source?: string;
    asOf?: Date;
    from?: Date;
    limit: number;
  }): Promise<NewsItem[]> {
    const rows = await this.prisma.newsItem.findMany({
      where: {
        ...(params.source ? { source: params.source } : {}),
        ...(params.instrument ? { instruments: { has: params.instrument } } : {}),
        ...(params.asOf || params.from
          ? {
              publishedAt: {
                ...(params.asOf ? { lte: params.asOf } : {}),
                ...(params.from ? { gte: params.from } : {}),
              },
            }
          : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: params.limit,
    });
    return rows.map((r) => ({
      id: r.id,
      publishedAt: r.publishedAt.toISOString(),
      source: r.source,
      externalId: r.externalId,
      headline: r.headline,
      summary: r.summary,
      url: r.url,
      instruments: r.instruments,
      sentiment: r.sentiment,
    }));
  }

  /** BE-043 — idempotent macro upsert (natural PK: series×releaseTs×revision). */
  async upsertMacro(items: MacroIngestItem[]): Promise<number> {
    let written = 0;
    for (const m of items) {
      const revision = m.revision ?? 0;
      await this.prisma.macroFeature.upsert({
        where: { series_releaseTs_revision: { series: m.series, releaseTs: m.releaseTs, revision } },
        create: {
          series: m.series,
          releaseTs: m.releaseTs,
          revision,
          period: m.period ?? null,
          value: m.value,
          source: m.source,
          raw: (m.raw ?? undefined) as never,
        },
        update: { value: m.value, period: m.period ?? null, raw: (m.raw ?? undefined) as never },
      });
      written += 1;
    }
    return written;
  }

  /**
   * BE-043 — release-time-aware macro read: only values whose `release_ts <=
   * asOf` are visible (COT joins on release, not the reference period).
   */
  async queryMacro(params: { series: string; asOf?: Date; limit: number }): Promise<MacroFeature[]> {
    const rows = await this.prisma.macroFeature.findMany({
      where: {
        series: params.series,
        ...(params.asOf ? { releaseTs: { lte: params.asOf } } : {}),
      },
      orderBy: { releaseTs: 'desc' },
      take: params.limit,
    });
    return rows.map((r) => ({
      series: r.series,
      releaseTs: r.releaseTs.toISOString(),
      revision: r.revision,
      period: r.period,
      value: r.value,
      source: r.source,
    }));
  }
}
