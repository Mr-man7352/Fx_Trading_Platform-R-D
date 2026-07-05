import type { MarketRepo, NewsIngestItem } from './repo.js';

/**
 * BE-042 — point-in-time news archive. The archive itself (dedup + immutable
 * `published_at` + PIT query) lives in `MarketRepo`; this module is the
 * provider-swappable ingestion seam. Live providers (GDELT, RSS, a paid API)
 * implement `NewsSource`; Phase 1 ships a stub so the pipeline is wired without
 * committing to a vendor. Swapping providers never touches the archive or the
 * PIT query — the no-look-ahead guarantee is enforced at read time in the repo.
 */
export interface NewsSource {
  readonly name: string;
  /** Fetch items published since `since` (exclusive), newest-first is fine. */
  fetch(since?: Date): Promise<NewsIngestItem[]>;
}

/** A fixed-list source — used by tests and dev seeding. */
export class StaticNewsSource implements NewsSource {
  readonly name: string;
  constructor(
    private readonly items: NewsIngestItem[],
    name = 'static',
  ) {
    this.name = name;
  }
  async fetch(since?: Date): Promise<NewsIngestItem[]> {
    return since ? this.items.filter((i) => i.publishedAt > since) : this.items;
  }
}

/**
 * Phase-1 placeholder live source. Returns nothing until a provider is chosen
 * (see credentials list); kept so the worker/route wiring is exercised end to
 * end. Replace with e.g. a GDELT or RSS adapter without other changes.
 */
export class StubNewsSource implements NewsSource {
  readonly name = 'stub';
  async fetch(): Promise<NewsIngestItem[]> {
    return [];
  }
}

/** Fetch from a source and persist to the archive (dedup handled by the repo). */
export async function ingestNewsFrom(
  source: NewsSource,
  repo: MarketRepo,
  since?: Date,
): Promise<{ inserted: number; skipped: number }> {
  const items = await source.fetch(since);
  if (items.length === 0) return { inserted: 0, skipped: 0 };
  return repo.ingestNews(items);
}
