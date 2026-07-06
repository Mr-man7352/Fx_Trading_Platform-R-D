import { MARKET_CANDLES_MAX_LIMIT, type Timeframe } from '@fx/types';
import type { DataQualityMonitor } from './data-quality.js';
import { getInstrument, pipSize } from './instruments.js';
import type { MarketRepo } from './repo.js';
import type { CandleSource, CrossCheckSource } from './vendors/types.js';

/**
 * BE-041 / QN-021 — historical backfill orchestrator. Pulls pages from any
 * `CandleSource`, upserts them idempotently (re-runs never duplicate), and
 * optionally sample-cross-checks against a secondary vendor, logging out-of-
 * tolerance discrepancies to the data-quality monitor. Depends only on the
 * adapter interfaces, so new vendors need no change here.
 */
export interface BackfillParams {
  source: CandleSource;
  repo: MarketRepo;
  instrument: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
  pageSize?: number;
  crossCheck?: CrossCheckSource;
  monitor?: DataQualityMonitor;
  crossCheckTolerancePips?: number;
  /** Sample one bar every N for cross-check (free-tier vendor rate limits). */
  crossCheckSampleEvery?: number;
}

export interface BackfillResult {
  instrument: string;
  timeframe: Timeframe;
  pages: number;
  candlesWritten: number;
  crossChecksSampled: number;
  discrepancies: number;
}

export async function backfillCandles(params: BackfillParams): Promise<BackfillResult> {
  const pageSize = params.pageSize ?? MARKET_CANDLES_MAX_LIMIT;
  const tolerance = params.crossCheckTolerancePips ?? 2;
  const sampleEvery = params.crossCheckSampleEvery ?? 200;
  const pip = pipSize(getInstrument(params.instrument) ?? ({ pipLocation: -4 } as never));

  const result: BackfillResult = {
    instrument: params.instrument,
    timeframe: params.timeframe,
    pages: 0,
    candlesWritten: 0,
    crossChecksSampled: 0,
    discrepancies: 0,
  };

  let barIndex = 0;
  for await (const page of params.source.fetchCandles({
    instrument: params.instrument,
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
    pageSize,
  })) {
    if (page.length === 0) continue;
    result.candlesWritten += await params.repo.upsertCandles(page);
    result.pages += 1;

    if (params.crossCheck) {
      for (const bar of page) {
        if (barIndex % sampleEvery === 0) {
          const vendorMid = await params.crossCheck.sampleMid(
            params.instrument,
            params.timeframe,
            bar.ts,
          );
          if (vendorMid !== null) {
            result.crossChecksSampled += 1;
            const discPips = (vendorMid - bar.close) / pip;
            if (Math.abs(discPips) > tolerance) result.discrepancies += 1;
            params.monitor?.reportCrossCheck(params.instrument, bar.ts, discPips, tolerance);
          }
        }
        barIndex += 1;
      }
    }
  }
  return result;
}
