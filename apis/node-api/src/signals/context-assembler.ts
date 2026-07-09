import type {
  AccountState,
  AgentInput,
  AgentRole,
  AgentStance,
  DebateDigest,
  DebateTurn,
  HoldReason,
  PipelineContext,
  QuantCandidate,
  ResearcherOutput,
  RetrievedMemory,
  RiskTeamOutput,
  SpecialistOutputs,
  Timeframe,
  TraderOutput,
  UntrustedNewsBlock,
} from '@fx/types';
import { AGENT_CONTRACT_VERSION, AgentContextContract, PipelineContextSchema } from '@fx/types';
import { z } from 'zod';
import type { PipelineResult } from './quant-pipeline-client.js';

/**
 * BE-074 — Agent context assembler (§9.6).
 *
 * The ONE component that builds and validates every role's context bundle —
 * context construction is owned here, never ad-hoc inside graph nodes
 * (BE-062 nodes receive already-validated bundles).
 *
 * - Feature partitioning mirrors `services/quant/app/quant/features.py
 *   partition_features()` EXACTLY: `macro_*` → macro, `sent_*` → sentiment,
 *   everything else → technical. Every feature lands in exactly one subset.
 * - Headlines are fetched here from `news_archive` with
 *   `published_at <= bar_ts` (PIT read via MarketRepo.queryNews — gRPC
 *   RunPipeline returns features only) and wrapped in the untrusted-data
 *   block (BE-063 injection boundary).
 * - The §9.5 memory slot is a seam: `MemoryRetriever` — BE-064's
 *   `AgentMemoryStore` fills it; `NULL_MEMORY` keeps ablation/backtest mode
 *   and pre-BE-064 wiring working. Retrieval failure degrades to [] — memory
 *   is an enhancement, never a reason to HOLD.
 * - Every bundle is validated against `AgentContextContract` BEFORE
 *   invocation; failure → `{ ok: false, reason: 'SCHEMA_INVALID' }` and the
 *   caller maps that role to HOLD/NEUTRAL (never a throw).
 * - The PM digest is a DETERMINISTIC code-built summary (ADR-011) —
 *   `buildDigest()` is a pure function of schema-validated agent outputs.
 */

// ─── Seams ───────────────────────────────────────────────────────────────────

/** Structural subset of MarketRepo — PIT news read (BE-042). */
export interface NewsReader {
  queryNews(params: { instrument?: string; asOf?: Date; limit: number }): Promise<
    Array<{
      publishedAt: string;
      source: string;
      headline: string;
      sentiment: number | null;
    }>
  >;
}

/** §9.5 retrieval seam — BE-064 implements; empty until then / when disabled. */
export interface MemoryRetriever {
  retrieve(params: {
    instrument: string;
    barTs: Date;
    agentRole: AgentRole;
    /** Deterministic feature summary used as the similarity query. */
    queryText: string;
    k?: number;
  }): Promise<RetrievedMemory[]>;
}

/** Memory disabled (quant-only ablation, BE-064 AC) or not yet wired. */
export const NULL_MEMORY: MemoryRetriever = {
  retrieve: async () => [],
};

// ─── Outcomes ────────────────────────────────────────────────────────────────

export type AssembleOutcome<R extends AgentRole> =
  | { ok: true; input: AgentInput<R> }
  | { ok: false; reason: HoldReason; detail: string };

/** Validated bar-level context shared by every role bundle. */
export interface PreparedContext {
  pipeline: PipelineContext;
  candidate: QuantCandidate;
  partitions: {
    technical: Record<string, number>;
    macro: Record<string, number>;
    sentiment: Record<string, number>;
  };
  /** Deterministic text used as the memory-retrieval similarity query. */
  querySummary: string;
}

// ─── Pure helpers (exported for tests + BE-062) ─────────────────────────────

/**
 * Mirror of quant `partition_features()` — keep byte-compatible with
 * services/quant/app/quant/features.py (QN-040 AC).
 */
export function partitionFeatures(features: Record<string, number>): PreparedContext['partitions'] {
  const technical: Record<string, number> = {};
  const macro: Record<string, number> = {};
  const sentiment: Record<string, number> = {};
  for (const [key, value] of Object.entries(features)) {
    if (key.startsWith('macro_')) macro[key] = value;
    else if (key.startsWith('sent_')) sentiment[key] = value;
    else technical[key] = value;
  }
  return { technical, macro, sentiment };
}

/**
 * §9.6 debate-depth rule: high HMM entropy (≥ 2/3 — same threshold as quant
 * `regime.debate_rounds()`) forces 2 rounds regardless of static config;
 * otherwise the configured value wins (BE-062 AC).
 */
export function effectiveDebateRounds(configured: 0 | 1 | 2, regimeEntropy: number): 0 | 1 | 2 {
  return regimeEntropy >= 2 / 3 ? 2 : configured;
}

/**
 * §9.6 consensus tiebreaker: bull/bear confidence diff < 0.1 (split vote) ⇒
 * trader gets `QUANT_DEFAULT` — follow quant if P ≥ threshold, else HOLD.
 */
export function tiebreakerMode(
  bullConfidence: number | null,
  bearConfidence: number | null,
): 'NONE' | 'QUANT_DEFAULT' {
  if (bullConfidence === null || bearConfidence === null) return 'NONE';
  return Math.abs(bullConfidence - bearConfidence) < 0.1 ? 'QUANT_DEFAULT' : 'NONE';
}

/**
 * ADR-011 — the PM's debate summary is a deterministic digest assembled by
 * CODE from schema-validated agent JSON. Never an LLM summarizer.
 */
export function buildDigest(params: {
  specialists: SpecialistOutputs;
  finalBull: ResearcherOutput | null;
  finalBear: ResearcherOutput | null;
  trader: TraderOutput;
  risk: RiskTeamOutput;
  tiebreakerApplied: boolean;
  degradedRoles: AgentRole[];
}): DebateDigest {
  const stanceOf = (s: { stance: AgentStance; confidence: number }) => ({
    stance: s.stance,
    confidence: s.confidence,
  });
  return {
    stances: {
      technical: stanceOf(params.specialists.technical),
      macro: stanceOf(params.specialists.macro),
      sentiment: stanceOf(params.specialists.sentiment),
    },
    finalRound: { bull: params.finalBull, bear: params.finalBear },
    traderAction: params.trader,
    riskConcerns: params.risk.concerns,
    tiebreakerApplied: params.tiebreakerApplied,
    // Sorted for byte-stable digests (deterministic replay, QN-062).
    degradedRoles: [...params.degradedRoles].sort(),
  };
}

/** Deterministic feature summary — the memory similarity query text (§9.5). */
export function querySummary(pipeline: PipelineContext, candidate: QuantCandidate): string {
  return [
    `instrument=${pipeline.instrument}`,
    `timeframe=${pipeline.timeframe}`,
    `side=${candidate.side}`,
    `p=${candidate.probability.toFixed(3)}`,
    `regime=${candidate.regime}`,
    `trend=${pipeline.trendRegime}`,
    `session=${pipeline.sessionLabel}`,
    `liquidity=${pipeline.liquidityRegime}`,
    `entropy=${pipeline.regimeEntropy.toFixed(3)}`,
  ].join(' ');
}

/** S/R levels from `sr_support_*` / `sr_resistance_*` feature keys (may be none). */
export function extractSupportResistance(
  technical: Record<string, number>,
): Array<{ level: number; kind: 'SUPPORT' | 'RESISTANCE' }> {
  const out: Array<{ level: number; kind: 'SUPPORT' | 'RESISTANCE' }> = [];
  for (const [key, value] of Object.entries(technical)) {
    if (key.startsWith('sr_support_')) out.push({ level: value, kind: 'SUPPORT' });
    else if (key.startsWith('sr_resistance_')) out.push({ level: value, kind: 'RESISTANCE' });
  }
  return out.sort((a, b) => a.level - b.level);
}

// ─── The assembler ───────────────────────────────────────────────────────────

export interface ContextAssemblerOptions {
  news: NewsReader;
  memory?: MemoryRetriever;
  /** Max headlines in the sentiment analyst's untrusted block. */
  headlineLimit?: number;
  /** §9.5 top-K memories per role. */
  memoryK?: number;
}

export class ContextAssembler {
  private readonly news: NewsReader;
  private readonly memory: MemoryRetriever;
  private readonly headlineLimit: number;
  private readonly memoryK: number;

  constructor(options: ContextAssemblerOptions) {
    this.news = options.news;
    this.memory = options.memory ?? NULL_MEMORY;
    this.headlineLimit = options.headlineLimit ?? 25;
    this.memoryK = options.memoryK ?? 5;
  }

  /**
   * Validate the bar-level pipeline context once, up front. A gRPC result
   * whose enums don't parse (e.g. unknown session label) fails HERE with
   * SCHEMA_INVALID — before any LLM cost is spent.
   */
  prepare(params: {
    result: PipelineResult;
    instrument: string;
    timeframe: Timeframe;
    barTs: Date;
    configuredDebateRounds: 0 | 1 | 2;
  }): { ok: true; prepared: PreparedContext } | { ok: false; reason: HoldReason; detail: string } {
    const { result } = params;
    if (!result.hasCandidate || result.candidate === null) {
      return { ok: false, reason: 'GATE_SKIP', detail: 'no quant candidate in pipeline result' };
    }
    const pipelineParse = PipelineContextSchema.safeParse({
      instrument: params.instrument,
      timeframe: params.timeframe,
      barTs: params.barTs.toISOString(),
      sessionLabel: result.sessionLabel,
      liquidityRegime: result.liquidityRegime,
      trendRegime: result.trendRegime,
      regimeEntropy: result.regimeEntropy,
      debateRounds: effectiveDebateRounds(params.configuredDebateRounds, result.regimeEntropy),
      featureSetVersion: result.featureSetVersion,
    } satisfies Record<keyof PipelineContext, unknown>);
    if (!pipelineParse.success) {
      return {
        ok: false,
        reason: 'SCHEMA_INVALID',
        detail: `pipeline context: ${z.prettifyError(pipelineParse.error)}`,
      };
    }
    const pipeline = pipelineParse.data;
    const candidate = result.candidate;
    return {
      ok: true,
      prepared: {
        pipeline,
        candidate,
        partitions: partitionFeatures(result.features),
        querySummary: querySummary(pipeline, candidate),
      },
    };
  }

  /** Retrieval failure degrades to [] — memory never causes a HOLD. */
  private async memoriesFor(
    prepared: PreparedContext,
    role: AgentRole,
  ): Promise<RetrievedMemory[]> {
    try {
      return await this.memory.retrieve({
        instrument: prepared.pipeline.instrument,
        barTs: new Date(prepared.pipeline.barTs),
        agentRole: role,
        queryText: prepared.querySummary,
        k: this.memoryK,
      });
    } catch {
      return [];
    }
  }

  private validate<R extends AgentRole>(role: R, bundle: unknown): AssembleOutcome<R> {
    const parsed = AgentContextContract[role].input.safeParse(bundle);
    if (parsed.success) return { ok: true, input: parsed.data as AgentInput<R> };
    return {
      ok: false,
      reason: 'SCHEMA_INVALID',
      detail: `${role} bundle: ${z.prettifyError(parsed.error)}`,
    };
  }

  private base(prepared: PreparedContext, role: AgentRole, memories: RetrievedMemory[]) {
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      role,
      pipeline: prepared.pipeline,
      candidate: prepared.candidate,
      memories,
    };
  }

  async assembleTechnical(
    prepared: PreparedContext,
  ): Promise<AssembleOutcome<'technical_analyst'>> {
    const memories = await this.memoriesFor(prepared, 'technical_analyst');
    return this.validate('technical_analyst', {
      ...this.base(prepared, 'technical_analyst', memories),
      indicators: prepared.partitions.technical,
      supportResistance: extractSupportResistance(prepared.partitions.technical),
    });
  }

  async assembleMacro(prepared: PreparedContext): Promise<AssembleOutcome<'macro_analyst'>> {
    const memories = await this.memoriesFor(prepared, 'macro_analyst');
    return this.validate('macro_analyst', {
      ...this.base(prepared, 'macro_analyst', memories),
      macroFeatures: prepared.partitions.macro,
      // Features are computed as-of the decided bar (release-time filtered
      // upstream in quant `_macro_features` — release_ts <= bar_ts).
      featuresAsOf: prepared.pipeline.barTs,
    });
  }

  async assembleSentiment(
    prepared: PreparedContext,
  ): Promise<AssembleOutcome<'sentiment_analyst'>> {
    const memories = await this.memoriesFor(prepared, 'sentiment_analyst');
    let news: UntrustedNewsBlock;
    try {
      const rows = await this.news.queryNews({
        instrument: prepared.pipeline.instrument,
        asOf: new Date(prepared.pipeline.barTs),
        limit: this.headlineLimit,
      });
      news = {
        kind: 'UNTRUSTED_DATA',
        headlines: rows.map((r) => ({
          publishedAt: r.publishedAt,
          source: r.source,
          headline: r.headline,
          sentimentScore: r.sentiment,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'SCHEMA_INVALID',
        detail: `news_archive read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return this.validate('sentiment_analyst', {
      ...this.base(prepared, 'sentiment_analyst', memories),
      sentimentFeatures: prepared.partitions.sentiment,
      news,
    });
  }

  async assembleResearcher<R extends 'bull_researcher' | 'bear_researcher'>(
    role: R,
    prepared: PreparedContext,
    specialists: SpecialistOutputs,
    priorTurns: DebateTurn[],
    round: number,
  ): Promise<AssembleOutcome<R>> {
    const memories = await this.memoriesFor(prepared, role);
    return this.validate(role, {
      ...this.base(prepared, role, memories),
      specialists,
      priorTurns,
      round,
    });
  }

  async assembleTrader(
    prepared: PreparedContext,
    specialists: SpecialistOutputs,
    debateTranscript: DebateTurn[],
    mode: 'NONE' | 'QUANT_DEFAULT',
  ): Promise<AssembleOutcome<'trader'>> {
    const memories = await this.memoriesFor(prepared, 'trader');
    return this.validate('trader', {
      ...this.base(prepared, 'trader', memories),
      specialists,
      debateTranscript,
      tiebreakerMode: mode,
    });
  }

  async assembleRiskTeam(
    prepared: PreparedContext,
    trader: TraderOutput,
    account: AccountState,
  ): Promise<AssembleOutcome<'risk_team'>> {
    const memories = await this.memoriesFor(prepared, 'risk_team');
    return this.validate('risk_team', {
      ...this.base(prepared, 'risk_team', memories),
      trader,
      quantProbability: prepared.candidate.probability,
      account,
    });
  }

  async assemblePm(
    prepared: PreparedContext,
    risk: RiskTeamOutput,
    trader: TraderOutput,
    digest: DebateDigest,
  ): Promise<AssembleOutcome<'pm'>> {
    const memories = await this.memoriesFor(prepared, 'pm');
    return this.validate('pm', {
      ...this.base(prepared, 'pm', memories),
      risk,
      trader,
      digest,
    });
  }
}
