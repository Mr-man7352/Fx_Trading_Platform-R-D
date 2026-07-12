import { z } from 'zod';
import { TimeframeSchema } from './market.js';
import { InstrumentSchema } from './trading.js';

/**
 * Step 4.2 — backtest contracts (BE-090 REST surface + QN-052 modes).
 *
 * Deliberately NOT registered in `contractSchemas`: the Python side defines
 * its own pydantic `BacktestRequest` (app/backtest/service.py) — keep the two
 * aligned by hand; registering here would churn the QN-003 codegen check.
 */

export const BacktestKindSchema = z.enum(['quant', 'agentic']);
export type BacktestKind = z.infer<typeof BacktestKindSchema>;

/** QN-052 — the three agentic execution modes. */
export const AgenticModeSchema = z.enum(['quant-only', 'cached-llm', 'live-llm']);
export type AgenticMode = z.infer<typeof AgenticModeSchema>;

export const BacktestConfigSchema = z
  .object({
    kind: BacktestKindSchema.default('quant'),
    instrument: InstrumentSchema,
    timeframe: TimeframeSchema.default('H1'),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    /** ADR-008 default; the quant engine additionally sweeps 0.55–0.70. */
    probabilityThreshold: z.number().gt(0).lt(1).default(0.6),
    riskPct: z.number().gt(0).lt(1).default(0.01),
    initialEquity: z.number().positive().default(10_000),
    runValidation: z.boolean().default(true),
    runAblations: z.boolean().default(false),
    /** Agentic-only (QN-056/QN-052); ignored for kind=quant. */
    mode: AgenticModeSchema.default('quant-only'),
    memoryEnabled: z.boolean().default(true),
    debateRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .refine((c) => new Date(c.from) < new Date(c.to), {
    message: 'from must be before to',
  });
export type BacktestConfig = z.infer<typeof BacktestConfigSchema>;

export const BacktestStatusSchema = z.enum(['queued', 'running', 'finished', 'failed']);
export type BacktestStatus = z.infer<typeof BacktestStatusSchema>;

export const BacktestRunSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  status: BacktestStatusSchema,
  config: z.record(z.string(), z.unknown()),
  /** Full engine/runner report (metrics, sweep, OOS split, ablation, trades). */
  metrics: z.record(z.string(), z.unknown()).nullable(),
  /** QN-053 — VALIDATED | NOT VALIDATED (blocks live promotion). */
  validationVerdict: z.string().nullable(),
  gitCommit: z.string().nullable(),
});
export type BacktestRun = z.infer<typeof BacktestRunSchema>;

export const BacktestCreateResponseSchema = z.object({
  id: z.uuid(),
  status: BacktestStatusSchema,
});
export type BacktestCreateResponse = z.infer<typeof BacktestCreateResponseSchema>;

export const BacktestListQuerySchema = z.object({
  status: BacktestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BacktestListQuery = z.infer<typeof BacktestListQuerySchema>;

export const BacktestListResponseSchema = z.object({
  backtests: z.array(BacktestRunSchema),
});
export type BacktestListResponse = z.infer<typeof BacktestListResponseSchema>;
