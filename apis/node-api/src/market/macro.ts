import type { MacroIngestItem, MarketRepo } from './repo.js';
import { defaultHttpClient, type HttpClient } from './vendors/types.js';

/**
 * BE-043 — macro features ingest (COT, EIA, FRED), release-time aware. The
 * critical invariant: `release_ts` is when a value became publicly known, so
 * backtests join on release, never on the reference period (no look-ahead).
 * COT is the sharp case — a report referencing Tuesday's positioning is only
 * published the following Friday.
 */
export interface MacroSource {
  readonly name: string;
  fetch(): Promise<MacroIngestItem[]>;
}

/**
 * CFTC Commitments of Traders release time for a given Tuesday reference date:
 * the following Friday at 15:30 America/New_York. We approximate NY as UTC-4
 * (EDT); DST-exact conversion lands with QN-047. The point is that the release
 * is ~3 days AFTER the data it describes — that lag is the whole no-look-ahead
 * concern for COT.
 */
export function cotReleaseTs(referenceTuesday: Date): Date {
  const d = new Date(referenceTuesday);
  const dow = d.getUTCDay(); // expect 2 (Tue)
  const daysToFriday = (5 - dow + 7) % 7 || 3; // Tue→Fri = 3
  const friday = new Date(d.getTime() + daysToFriday * 24 * 60 * 60_000);
  friday.setUTCHours(19, 30, 0, 0); // 15:30 EDT ≈ 19:30 UTC
  return friday;
}

/** Static COT source (CFTC data is public; a live fetcher slots in later). */
export class StaticCotSource implements MacroSource {
  readonly name = 'cot';
  constructor(private readonly rows: { series: string; referenceTuesday: Date; value: number }[]) {}
  async fetch(): Promise<MacroIngestItem[]> {
    return this.rows.map((r) => ({
      series: r.series,
      releaseTs: cotReleaseTs(r.referenceTuesday),
      value: r.value,
      period: r.referenceTuesday.toISOString().slice(0, 10),
      source: 'cftc',
    }));
  }
}

interface FredOptions {
  apiKey: string;
  seriesIds: string[];
  http?: HttpClient;
  host?: string;
}

/**
 * FRED source — requires FRED_API_KEY. Uses `realtime_start` as the release
 * timestamp so revisions are release-time aware. Returns [] with no key so the
 * pipeline stays wired in mock-first mode.
 */
export class FredSource implements MacroSource {
  readonly name = 'fred';
  private readonly http: HttpClient;
  private readonly host: string;
  constructor(private readonly opts: FredOptions) {
    this.http = opts.http ?? defaultHttpClient;
    this.host = opts.host ?? 'https://api.stlouisfed.org';
  }
  async fetch(): Promise<MacroIngestItem[]> {
    if (!this.opts.apiKey) return [];
    const out: MacroIngestItem[] = [];
    for (const series of this.opts.seriesIds) {
      const url =
        `${this.host}/fred/series/observations?series_id=${encodeURIComponent(series)}` +
        `&api_key=${encodeURIComponent(this.opts.apiKey)}&file_type=json&realtime_start=2020-01-01`;
      const res = await this.http(url);
      if (!res.ok) continue;
      const body = (await res.json()) as {
        observations?: { date: string; realtime_start: string; value: string }[];
      };
      for (const o of body.observations ?? []) {
        if (o.value === '.') continue; // FRED missing-value marker
        out.push({
          series,
          releaseTs: new Date(`${o.realtime_start}T00:00:00Z`),
          period: o.date,
          value: Number(o.value),
          source: 'fred',
        });
      }
    }
    return out;
  }
}

/**
 * EIA weekly petroleum status (e.g. WTI inventories) — requires EIA_API_KEY.
 * `period` is the report week; `releaseTs` is EIA's Wednesday 10:30 ET print.
 * Returns [] with no key.
 */
export class EiaSource implements MacroSource {
  readonly name = 'eia';
  private readonly http: HttpClient;
  private readonly host: string;
  constructor(
    private readonly opts: { apiKey: string; seriesIds: string[]; http?: HttpClient; host?: string },
  ) {
    this.http = opts.http ?? defaultHttpClient;
    this.host = opts.host ?? 'https://api.eia.gov';
  }
  async fetch(): Promise<MacroIngestItem[]> {
    if (!this.opts.apiKey) return [];
    const out: MacroIngestItem[] = [];
    for (const series of this.opts.seriesIds) {
      const url = `${this.host}/v2/seriesid/${encodeURIComponent(series)}?api_key=${encodeURIComponent(this.opts.apiKey)}`;
      const res = await this.http(url);
      if (!res.ok) continue;
      const body = (await res.json()) as { response?: { data?: { period: string; value: number }[] } };
      for (const d of body.response?.data ?? []) {
        const release = new Date(`${d.period}T14:30:00Z`); // 10:30 EDT ≈ 14:30 UTC
        out.push({ series, releaseTs: release, period: d.period, value: Number(d.value), source: 'eia' });
      }
    }
    return out;
  }
}

/** Fetch from a macro source and upsert idempotently (release-time aware). */
export async function ingestMacroFrom(source: MacroSource, repo: MarketRepo): Promise<number> {
  const items = await source.fetch();
  return items.length === 0 ? 0 : repo.upsertMacro(items);
}
