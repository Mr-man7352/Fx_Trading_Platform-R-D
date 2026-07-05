import { z } from 'zod';
import { InstrumentSchema } from './trading.js';

/**
 * Step 1.6 — market-data contracts (candles, instruments, news, macro,
 * data-quality). Source of truth for BE-040…045 REST/worker shapes; the
 * cross-service ones (Timeframe, Candle) are registered in `contractSchemas`
 * so the Python quant service gets matching Pydantic models via QN-003 codegen.
 */

/** Mirrors the Prisma `Timeframe` enum (schema.prisma). Base ingest is M1. */
export const TimeframeSchema = z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);
export type Timeframe = z.infer<typeof TimeframeSchema>;

/**
 * OHLCV bar for an instrument × timeframe. `ts` is the bar-open time (UTC).
 * M1 is written by ingest (BE-040/QN-020); M5…D1 come from TimescaleDB
 * continuous aggregates. `complete=false` marks the still-forming current bar.
 */
export const CandleSchema = z.object({
  instrument: InstrumentSchema,
  timeframe: TimeframeSchema,
  ts: z.iso.datetime(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().default(0),
  complete: z.boolean().default(true),
  source: z.string().default('oanda'),
});
export type Candle = z.infer<typeof CandleSchema>;

// ─── BE-045 — GET /market/candles ────────────────────────────────────────────

/** Max bars per page — matches OANDA's 5,000/request backfill cap. */
export const MARKET_CANDLES_MAX_LIMIT = 5000;

export const MarketCandlesQuerySchema = z.object({
  instrument: InstrumentSchema,
  timeframe: TimeframeSchema.default('H1'),
  /** ISO lower bound (inclusive) on bar-open time. */
  from: z.iso.datetime().optional(),
  /** ISO upper bound (exclusive) on bar-open time. */
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MARKET_CANDLES_MAX_LIMIT).default(500),
  /** Include the still-forming current bar (`complete=false`). Default off. */
  includeIncomplete: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type MarketCandlesQuery = z.infer<typeof MarketCandlesQuerySchema>;

export const MarketCandlesResponseSchema = z.object({
  instrument: InstrumentSchema,
  timeframe: TimeframeSchema,
  candles: z.array(CandleSchema),
  /**
   * Cursor for the next page: pass as `from` to continue. Null when the page
   * was not full (caller has reached the end of available history).
   */
  nextFrom: z.iso.datetime().nullable(),
});
export type MarketCandlesResponse = z.infer<typeof MarketCandlesResponseSchema>;

// ─── BE-045 — GET /market/instruments ────────────────────────────────────────

/** Instrument classes traded by the platform (System Design §scope). */
export const InstrumentKindSchema = z.enum(['fx_major', 'metal', 'energy']);
export type InstrumentKind = z.infer<typeof InstrumentKindSchema>;

/**
 * Static instrument registry entry with broker symbol mappings. There is no
 * `instruments` DB table (Step 1.4); this registry is config-driven and is the
 * seed for QN-033's fuller symbol-mapping table in Phase 2.
 */
export const InstrumentInfoSchema = z.object({
  /** Canonical OANDA-style name, e.g. EUR_USD, XAU_USD, BCO_USD. */
  name: InstrumentSchema,
  displayName: z.string(),
  kind: InstrumentKindSchema,
  /** Broker symbol at OANDA v20 (usually identical to `name`). */
  oandaSymbol: z.string(),
  /** Twelve Data cross-check symbol (QN-021), null when unsupported there. */
  twelveDataSymbol: z.string().nullable(),
  /**
   * Power-of-ten location of one pip, e.g. -4 for EUR_USD (0.0001),
   * -2 for USD_JPY / XAU_USD. Drives pip/spread maths (QN-034, Phase 2).
   */
  pipLocation: z.number().int(),
  quoteCurrency: z.string().length(3),
  /** False = data-only (charts/backfill) but not order-eligible in Phase 1. */
  tradeable: z.boolean().default(true),
});
export type InstrumentInfo = z.infer<typeof InstrumentInfoSchema>;

export const MarketInstrumentsResponseSchema = z.object({
  instruments: z.array(InstrumentInfoSchema),
});
export type MarketInstrumentsResponse = z.infer<typeof MarketInstrumentsResponseSchema>;

// ─── BE-042 — point-in-time news archive ─────────────────────────────────────

export const NewsItemSchema = z.object({
  id: z.string(),
  publishedAt: z.iso.datetime(),
  source: z.string(),
  externalId: z.string().nullable(),
  headline: z.string(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  instruments: z.array(z.string()),
  /** FinBERT signed sentiment in [-1, 1] (QN-022); null until scored. */
  sentiment: z.number().nullable(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const NewsQuerySchema = z.object({
  instrument: InstrumentSchema.optional(),
  source: z.string().optional(),
  /**
   * Point-in-time cutoff (inclusive): only items with `published_at <= asOf`
   * are returned. This is the no-look-ahead guarantee (BE-042) — backtests
   * pass the bar timestamp here.
   */
  asOf: z.iso.datetime().optional(),
  /** ISO lower bound (inclusive) on published_at. */
  from: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NewsQuery = z.infer<typeof NewsQuerySchema>;

export const NewsPageSchema = z.object({
  items: z.array(NewsItemSchema),
  /** ISO cursor: pass as `asOf` to fetch the next (older) page. Null at end. */
  nextBefore: z.iso.datetime().nullable(),
});
export type NewsPage = z.infer<typeof NewsPageSchema>;

// ─── BE-043 — release-time-aware macro features ──────────────────────────────

/**
 * A COT/EIA/FRED datapoint. `releaseTs` is when the value became publicly known
 * (backtests join on this, never the reference `period`) — the no-look-ahead
 * guarantee for macro. `revision` distinguishes restated prints of the same
 * series×release.
 */
export const MacroFeatureSchema = z.object({
  series: z.string(),
  releaseTs: z.iso.datetime(),
  revision: z.number().int(),
  period: z.string().nullable(),
  value: z.number(),
  source: z.string(),
});
export type MacroFeature = z.infer<typeof MacroFeatureSchema>;

// ─── BE-044 — data-quality monitor ───────────────────────────────────────────

export const DataQualityKindSchema = z.enum(['gap', 'stale', 'spread_anomaly', 'cross_check']);
export type DataQualityKind = z.infer<typeof DataQualityKindSchema>;

export const DataQualitySeveritySchema = z.enum(['info', 'warn', 'critical']);
export type DataQualitySeverity = z.infer<typeof DataQualitySeveritySchema>;

/**
 * A single data-quality finding. `degraded=true` on a critical instrument
 * flag is what the risk gate (BE-070, Phase 3) reads to block new entries.
 */
export const DataQualityFlagSchema = z.object({
  kind: DataQualityKindSchema,
  severity: DataQualitySeveritySchema,
  instrument: InstrumentSchema,
  message: z.string(),
  at: z.iso.datetime(),
  degraded: z.boolean(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type DataQualityFlag = z.infer<typeof DataQualityFlagSchema>;
