import { z } from 'zod';
import { TimeframeSchema } from './market.js';
import { InstrumentSchema, TradeSideSchema } from './trading.js';

/**
 * BE-069 — Agent context contracts (system design §9.6).
 *
 * Formal per-role input/output Zod schemas for the 8-agent LangGraph stack
 * (Step 3.2). Every context bundle is validated BEFORE invocation (BE-074)
 * and every LLM output is validated against its role's output schema —
 * validation failure ⇒ HOLD/NEUTRAL for that role, never a crash.
 *
 * These contracts are Node-internal (assembler → LangGraph → persistence);
 * they are deliberately NOT registered in `contractSchemas` — Python never
 * consumes them, and registering would churn the QN-003 codegen drift check.
 *
 * Versioning: bump `AGENT_CONTRACT_VERSION` on ANY schema change here. The
 * prompt registry (BE-061, `@fx/llm`) folds this version into `prompt_hash`,
 * so a contract change automatically changes every prompt hash and flags
 * re-validation.
 */
export const AGENT_CONTRACT_VERSION = 1;

// ─── Roles & shared primitives ───────────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  'technical_analyst',
  'macro_analyst',
  'sentiment_analyst',
  'bull_researcher',
  'bear_researcher',
  'trader',
  'risk_team',
  'pm',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentStanceSchema = z.enum(['BULL', 'BEAR', 'NEUTRAL']);
export type AgentStance = z.infer<typeof AgentStanceSchema>;

/** All agent confidences are calibrated to [0, 1]. */
export const ConfidenceSchema = z.number().min(0).max(1);

/**
 * Reason codes for deterministic HOLD/NEUTRAL/VETO outcomes across the
 * signal pipeline (ADR-010, §2.2 budgets, BE-068 breaker). Persist these,
 * never free text — cohort queries (BE-065) group on them.
 */
export const HoldReasonSchema = z.enum([
  /** Entry gate: no quant candidate or P < 0.50 pre-filter — zero LLM cost. */
  'GATE_SKIP',
  /** gRPC RunPipeline exceeded its stage budget (30s H1). */
  'GRPC_TIMEOUT',
  /** gRPC transport failure (UNAVAILABLE/UNKNOWN/UNIMPLEMENTED). */
  'GRPC_UNAVAILABLE',
  /** No champion model promoted — quant returns FAILED_PRECONDITION. */
  'NO_CHAMPION',
  /** BE-068 circuit breaker open — call not attempted. */
  'CIRCUIT_OPEN',
  /** Agent output failed its role's output schema validation. */
  'SCHEMA_INVALID',
  /** A per-stage sub-budget (§2.2) was exceeded. */
  'STAGE_TIMEOUT',
  /** LangGraph full-graph or end-to-end budget exceeded. */
  'BUDGET_EXCEEDED',
  /** LLM provider chain exhausted (primary + one fallback both failed). */
  'PROVIDER_EXHAUSTED',
]);
export type HoldReason = z.infer<typeof HoldReasonSchema>;

// ─── Quant candidate & pipeline context (mirrors proto RunPipelineResponse) ──

/** Mirrors `fx.quant.v1.Candidate` — the deterministic quant candidate. */
export const QuantCandidateSchema = z.object({
  instrument: InstrumentSchema,
  side: TradeSideSchema,
  /** Calibrated P(profitable) for exactly this bracket geometry (QN-043). */
  probability: ConfidenceSchema,
  regime: z.string(),
  modelVersion: z.string(),
  entryPrice: z.number(),
  stopLossPrice: z.number(),
  takeProfitPrice: z.number(),
});
export type QuantCandidate = z.infer<typeof QuantCandidateSchema>;

export const SessionLabelSchema = z.enum(['TOKYO', 'LONDON', 'NEW_YORK', 'OVERLAP', 'OFF_HOURS']);
export const LiquidityRegimeSchema = z.enum(['HIGH', 'NORMAL', 'LOW']);
export const TrendRegimeSchema = z.enum(['TREND_UP', 'TREND_DOWN', 'RANGE']);

/** Bar-level pipeline context shared by every role bundle (QN-040/041/047). */
export const PipelineContextSchema = z.object({
  instrument: InstrumentSchema,
  timeframe: TimeframeSchema,
  /** Close time (UTC) of the bar that fired the cycle. */
  barTs: z.iso.datetime(),
  sessionLabel: SessionLabelSchema,
  liquidityRegime: LiquidityRegimeSchema,
  trendRegime: TrendRegimeSchema,
  /** 0..1 HMM entropy — drives debate depth (§9.6 mapping). */
  regimeEntropy: z.number().min(0).max(1),
  debateRounds: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  featureSetVersion: z.number().int(),
});
export type PipelineContext = z.infer<typeof PipelineContextSchema>;

// ─── Memory slot (§9.5 — BE-064 fills it; the contract exposes it now) ──────

export const RetrievedMemorySchema = z.object({
  id: z.uuid(),
  /** Always <= current barTs — hard temporal filter, no look-ahead. */
  barTs: z.iso.datetime(),
  summary: z.string(),
  /** Realized outcome once trade closed (R-multiple, SL/TP hit …). */
  outcome: z.record(z.string(), z.unknown()).nullable(),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemorySchema>;

// ─── Untrusted data block (BE-063 — news text is DATA, never instructions) ──

export const UntrustedHeadlineSchema = z.object({
  publishedAt: z.iso.datetime(),
  source: z.string(),
  headline: z.string(),
  /** Signed FinBERT score (QN-022); null while sentiment is still mock. */
  sentimentScore: z.number().min(-1).max(1).nullable(),
});

/**
 * Wrapper that marks headline text as untrusted. The sentiment prompt must
 * render this block inside explicit data delimiters; the red-team suite
 * (BE-063) asserts injected instructions inside it never alter behaviour.
 */
export const UntrustedNewsBlockSchema = z.object({
  kind: z.literal('UNTRUSTED_DATA'),
  headlines: z.array(UntrustedHeadlineSchema),
});
export type UntrustedNewsBlock = z.infer<typeof UntrustedNewsBlockSchema>;

// ─── Shared bundle base ──────────────────────────────────────────────────────

const ContextBase = z.object({
  contractVersion: z.literal(AGENT_CONTRACT_VERSION),
  role: AgentRoleSchema,
  pipeline: PipelineContextSchema,
  candidate: QuantCandidateSchema,
  /** §9.5 retrieval slot — empty array until BE-064 lands. */
  memories: z.array(RetrievedMemorySchema),
});

// ─── Specialist analysts (parallel, disjoint inputs by contract) ─────────────

/** Technical analyst: regime label, indicator features, S/R, session. */
export const TechnicalAnalystInputSchema = ContextBase.extend({
  role: z.literal('technical_analyst'),
  /** Technical partition of the quant feature map (BE-074 owns the split). */
  indicators: z.record(z.string(), z.number()),
  supportResistance: z.array(
    z.object({ level: z.number(), kind: z.enum(['SUPPORT', 'RESISTANCE']) }),
  ),
});

/** Macro analyst: COT / FRED / EIA features — release-time filtered upstream. */
export const MacroAnalystInputSchema = ContextBase.extend({
  role: z.literal('macro_analyst'),
  macroFeatures: z.record(z.string(), z.number()),
  /** Latest release time included — audit that filtering was point-in-time. */
  featuresAsOf: z.iso.datetime(),
});

/** Sentiment analyst: FinBERT scores + headlines inside the untrusted block. */
export const SentimentAnalystInputSchema = ContextBase.extend({
  role: z.literal('sentiment_analyst'),
  sentimentFeatures: z.record(z.string(), z.number()),
  news: UntrustedNewsBlockSchema,
});

/** Shared output for all three specialists. */
export const SpecialistOutputSchema = z.strictObject({
  stance: AgentStanceSchema,
  confidence: ConfidenceSchema,
  rationale: z.string().min(1),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

/** Specialist outputs keyed by domain — input to researchers/trader/digest. */
export const SpecialistOutputsSchema = z.object({
  technical: SpecialistOutputSchema,
  macro: SpecialistOutputSchema,
  sentiment: SpecialistOutputSchema,
});
export type SpecialistOutputs = z.infer<typeof SpecialistOutputsSchema>;

// ─── Debate (bull/bear researchers) ──────────────────────────────────────────

export const DebateTurnSchema = z.object({
  round: z.number().int().min(0),
  speaker: z.enum(['bull', 'bear']),
  argument: z.string(),
  confidence: ConfidenceSchema,
});
export type DebateTurn = z.infer<typeof DebateTurnSchema>;

const ResearcherBase = ContextBase.extend({
  specialists: SpecialistOutputsSchema,
  /** Prior rounds' turns (empty in round 0). */
  priorTurns: z.array(DebateTurnSchema),
  round: z.number().int().min(0),
});

export const BullResearcherInputSchema = ResearcherBase.extend({
  role: z.literal('bull_researcher'),
});
export const BearResearcherInputSchema = ResearcherBase.extend({
  role: z.literal('bear_researcher'),
});

export const ResearcherOutputSchema = z.strictObject({
  argument: z.string().min(1),
  confidence: ConfidenceSchema,
});
export type ResearcherOutput = z.infer<typeof ResearcherOutputSchema>;

// ─── Trader ──────────────────────────────────────────────────────────────────

/**
 * QUANT_DEFAULT is set when bull/bear confidences differ by <0.1 (split
 * vote): follow the quant candidate if P ≥ threshold, else HOLD — never
 * unstructured LLM discretion (§9.6).
 */
export const TiebreakerModeSchema = z.enum(['NONE', 'QUANT_DEFAULT']);

export const TraderInputSchema = ContextBase.extend({
  role: z.literal('trader'),
  specialists: SpecialistOutputsSchema,
  /** FULL debate transcript — the trader sees everything (§9.6). */
  debateTranscript: z.array(DebateTurnSchema),
  tiebreakerMode: TiebreakerModeSchema,
});

export const TraderOutputSchema = z
  .strictObject({
    action: z.enum(['ENTER', 'HOLD', 'EXIT']),
    direction: TradeSideSchema.nullable(),
    confidence: ConfidenceSchema,
  })
  .refine((v) => v.action !== 'ENTER' || v.direction !== null, {
    message: 'direction is required when action is ENTER',
    path: ['direction'],
  });
export type TraderOutput = z.infer<typeof TraderOutputSchema>;

// ─── Risk team ───────────────────────────────────────────────────────────────

export const AccountStateSchema = z.object({
  equity: z.number(),
  openPositions: z.number().int().min(0),
  /** Realized+unrealized daily P&L as a fraction of equity (e.g. -0.013). */
  dailyPnlPct: z.number(),
  /** Aggregate risk at stops across open positions, fraction of equity. */
  openRiskPct: z.number().min(0),
});
export type AccountState = z.infer<typeof AccountStateSchema>;

export const RiskTeamInputSchema = ContextBase.extend({
  role: z.literal('risk_team'),
  trader: TraderOutputSchema,
  /** Raw calibrated quant P(profitable), pre-any-agent. */
  quantProbability: ConfidenceSchema,
  account: AccountStateSchema,
});

export const RiskTeamOutputSchema = z.strictObject({
  approve: z.boolean(),
  concerns: z.array(z.string()),
});
export type RiskTeamOutput = z.infer<typeof RiskTeamOutputSchema>;

// ─── PM (deterministic digest input — ADR-011) ──────────────────────────────

/**
 * The PM's debate summary is a DETERMINISTIC DIGEST assembled by code from
 * schema-validated agent JSON — never an LLM summarizer (ADR-011). BE-074
 * builds it; this schema is the digest's contract.
 */
export const DebateDigestSchema = z.object({
  stances: z.object({
    technical: z.object({ stance: AgentStanceSchema, confidence: ConfidenceSchema }),
    macro: z.object({ stance: AgentStanceSchema, confidence: ConfidenceSchema }),
    sentiment: z.object({ stance: AgentStanceSchema, confidence: ConfidenceSchema }),
  }),
  finalRound: z.object({
    bull: ResearcherOutputSchema.nullable(),
    bear: ResearcherOutputSchema.nullable(),
  }),
  traderAction: TraderOutputSchema,
  riskConcerns: z.array(z.string()),
  tiebreakerApplied: z.boolean(),
  /** Roles that timed out and degraded to NEUTRAL (§2.2). */
  degradedRoles: z.array(AgentRoleSchema),
});
export type DebateDigest = z.infer<typeof DebateDigestSchema>;

export const PmInputSchema = ContextBase.extend({
  role: z.literal('pm'),
  risk: RiskTeamOutputSchema,
  trader: TraderOutputSchema,
  /** Summary ONLY — the PM never sees the full transcript (§9.6). */
  digest: DebateDigestSchema,
});

export const PmOutputSchema = z.strictObject({
  decision: z.enum(['APPROVE', 'VETO', 'HOLD']),
  rationale: z.string().min(1),
});
export type PmOutput = z.infer<typeof PmOutputSchema>;

// ─── The contract map (BE-069 acceptance: all 8 roles) ───────────────────────

export const AgentContextContract = {
  technical_analyst: { input: TechnicalAnalystInputSchema, output: SpecialistOutputSchema },
  macro_analyst: { input: MacroAnalystInputSchema, output: SpecialistOutputSchema },
  sentiment_analyst: { input: SentimentAnalystInputSchema, output: SpecialistOutputSchema },
  bull_researcher: { input: BullResearcherInputSchema, output: ResearcherOutputSchema },
  bear_researcher: { input: BearResearcherInputSchema, output: ResearcherOutputSchema },
  trader: { input: TraderInputSchema, output: TraderOutputSchema },
  risk_team: { input: RiskTeamInputSchema, output: RiskTeamOutputSchema },
  pm: { input: PmInputSchema, output: PmOutputSchema },
} as const satisfies Record<AgentRole, { input: z.ZodType; output: z.ZodType }>;

export type AgentInput<R extends AgentRole> = z.infer<(typeof AgentContextContract)[R]['input']>;
export type AgentOutput<R extends AgentRole> = z.infer<(typeof AgentContextContract)[R]['output']>;

// ─── BE-067 — signals REST surface ───────────────────────────────────────────

export const SignalStatusSchema = z.enum([
  'candidate',
  'approved',
  'rejected',
  'expired',
  'executed',
]);
export type SignalStatus = z.infer<typeof SignalStatusSchema>;

export const SignalsQuerySchema = z.object({
  instrument: InstrumentSchema.optional(),
  status: SignalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SignalsQuery = z.infer<typeof SignalsQuerySchema>;

/** One recent candidate + a compact agent-cycle summary (BE-067). */
export const SignalSummarySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  barTs: z.iso.datetime(),
  instrument: z.string(),
  timeframe: TimeframeSchema,
  side: TradeSideSchema,
  entryPrice: z.number().nullable(),
  stopLoss: z.number().nullable(),
  takeProfit: z.number().nullable(),
  /** Calibrated quant P(profitable) for the candidate. */
  probability: z.number().nullable(),
  status: SignalStatusSchema,
  agents: z.object({
    llmCalls: z.number().int(),
    costUsd: z.number(),
    roles: z.array(z.string()),
    anyDowngraded: z.boolean(),
  }),
  debateTurns: z.number().int(),
});
export type SignalSummary = z.infer<typeof SignalSummarySchema>;

export const SignalsResponseSchema = z.object({
  signals: z.array(SignalSummarySchema),
});
export type SignalsResponse = z.infer<typeof SignalsResponseSchema>;

/**
 * Validate an LLM's raw JSON against its role's output schema. Callers map
 * `ok: false` to HOLD/NEUTRAL with reason `SCHEMA_INVALID` — never throw.
 */
export function validateAgentOutput<R extends AgentRole>(
  role: R,
  data: unknown,
): { ok: true; value: AgentOutput<R> } | { ok: false; error: string } {
  const result = AgentContextContract[role].output.safeParse(data);
  if (result.success) return { ok: true, value: result.data as AgentOutput<R> };
  return { ok: false, error: z.prettifyError(result.error) };
}
