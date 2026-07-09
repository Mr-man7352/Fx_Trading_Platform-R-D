import type { EmbeddingProvider } from '@fx/llm';
import type { AgentRole, RetrievedMemory } from '@fx/types';
import type { AgentGraphResult } from './agent-graph.js';
import type { MemoryRetriever, PreparedContext } from './context-assembler.js';

/**
 * BE-064 — agent memory with vector retrieval (§9.5).
 *
 * Retrieval (`MemoryRetriever` — plugs into BE-074's assembler slot):
 * - HARD temporal filter `bar_ts <= current_bar_ts` — no look-ahead, ever
 *   (backtest and live share this code path).
 * - Instrument match; ranked by pgvector cosine distance (`<=>`, HNSW
 *   index from timescale.sql); top-K default 5.
 * - Memories older than 18 months decay out of the top-K ranking
 *   (implemented as a read-time window — they stay stored, never surface).
 * - Only rows whose `embedding_model` matches the ACTIVE provider are
 *   candidates — two vector spaces never silently mix; switching models
 *   requires an explicit re-embed migration (§9.5 versioning).
 * - Retrieved ids bump `retrieval_count` (relevance-weighted eviction) and
 *   are passed to the LLM ledger → `agent_runs.retrieved_memory_ids`
 *   (QN-062 deterministic replay).
 *
 * Write protocol (two-phase, outcome-linked):
 * 1. After the PM decision, `writeReflection` embeds a DETERMINISTIC
 *    code-composed summary (`composeReflection`) and inserts it. Composing
 *    in code (not an LLM summarizer node) follows ADR-011's logic: zero
 *    cost, reproducible, and no second-order injection surface — the only
 *    LLM text that can reach memory is schema-validated output fields,
 *    which the BE-063 memory-persistence suite red-teams directly.
 * 2. On trade close / candidate expiry, `recordOutcome` attaches the
 *    realized outcome (R-multiple, SL/TP hit, holding period) via
 *    `signal_id` — retrieval surfaces what WORKED, not just what was argued.
 *
 * Hygiene: near-duplicates (cosine > 0.95, same instrument + model) are
 * merged AT WRITE TIME — the existing row wins and inherits the new
 * `signal_id` so the freshest outcome still attaches. `enforceCap` keeps
 * max 500 memories per instrument, evicting least-retrieved-then-oldest.
 */

// ─── Prisma raw seam (structural — tests inject fakes) ──────────────────────

export interface RawDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

// ─── Deterministic reflection composer ───────────────────────────────────────

const clip = (text: string, max = 280): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Code-composed debate reflection. Pure function of the (schema-validated)
 * graph result — same inputs, same text, byte-for-byte.
 */
export function composeReflection(prepared: PreparedContext, result: AgentGraphResult): string {
  const { pipeline, candidate } = prepared;
  const s = result.specialists;
  const lines = [
    `${pipeline.instrument} ${pipeline.timeframe} ${candidate.side.toUpperCase()} candidate at ${pipeline.barTs} — quant P=${candidate.probability.toFixed(2)}, regime=${candidate.regime}, session=${pipeline.sessionLabel}, entropy=${pipeline.regimeEntropy.toFixed(2)}.`,
    `Specialists: technical ${s.technical.stance} (${s.technical.confidence.toFixed(2)}) — ${clip(s.technical.rationale, 160)} | macro ${s.macro.stance} (${s.macro.confidence.toFixed(2)}) — ${clip(s.macro.rationale, 160)} | sentiment ${s.sentiment.stance} (${s.sentiment.confidence.toFixed(2)}) — ${clip(s.sentiment.rationale, 160)}`,
  ];
  const bull = result.digest?.finalRound.bull;
  const bear = result.digest?.finalRound.bear;
  if (bull) lines.push(`Bull (${bull.confidence.toFixed(2)}): ${clip(bull.argument)}`);
  if (bear) lines.push(`Bear (${bear.confidence.toFixed(2)}): ${clip(bear.argument)}`);
  if (result.trader) {
    lines.push(
      `Trader: ${result.trader.action}${result.trader.direction ? ` ${result.trader.direction}` : ''} (${result.trader.confidence.toFixed(2)})${result.tiebreakerApplied ? ' [tiebreaker QUANT_DEFAULT]' : ''}.`,
    );
  }
  if (result.risk) {
    lines.push(
      `Risk team: ${result.risk.approve ? 'approve' : 'object'}${result.risk.concerns.length > 0 ? ` — concerns: ${clip(result.risk.concerns.join('; '), 240)}` : ''}.`,
    );
  }
  lines.push(
    `Decision: ${result.decision}${result.holdReason ? ` (${result.holdReason})` : ''}${result.pm ? ` — ${clip(result.pm.rationale, 240)}` : ''}${result.degradedRoles.length > 0 ? ` [degraded: ${result.degradedRoles.join(', ')}]` : ''}`,
  );
  return lines.join('\n');
}

/** Realized outcome attached on trade close / candidate expiry (BE-064 AC). */
export interface MemoryOutcome {
  /** Realized R-multiple (risk units); negative for losses. */
  rMultiple: number | null;
  /** SL_HIT | TP_HIT | MANUAL_CLOSE | SUPERVISOR_CLOSE | EXPIRED … */
  exitReason: string;
  holdingHours: number | null;
  [key: string]: unknown;
}

// ─── The store ───────────────────────────────────────────────────────────────

export interface AgentMemoryStoreOptions {
  /** §9.5 default K. */
  k?: number;
  /** Near-duplicate merge threshold (cosine similarity). */
  mergeThreshold?: number;
  /** Read-time decay window in months. */
  decayMonths?: number;
  /** Per-instrument cap for `enforceCap`. */
  instrumentCap?: number;
}

interface MemoryRow {
  id: string;
  bar_ts: Date;
  summary: string;
  outcome: unknown;
}

export class AgentMemoryStore implements MemoryRetriever {
  private readonly k: number;
  private readonly mergeThreshold: number;
  private readonly decayMonths: number;
  private readonly instrumentCap: number;

  constructor(
    private readonly db: RawDb,
    private readonly embeddings: EmbeddingProvider,
    options: AgentMemoryStoreOptions = {},
  ) {
    this.k = options.k ?? 5;
    this.mergeThreshold = options.mergeThreshold ?? 0.95;
    this.decayMonths = options.decayMonths ?? 18;
    this.instrumentCap = options.instrumentCap ?? 500;
  }

  /**
   * §9.5 retrieval. Role-agnostic by design (the spec filters on instrument
   * + bar_ts only); `agentRole` is accepted for interface compatibility and
   * future per-role memories.
   */
  async retrieve(params: {
    instrument: string;
    barTs: Date;
    agentRole: AgentRole;
    queryText: string;
    k?: number;
  }): Promise<RetrievedMemory[]> {
    const [queryVec] = await this.embeddings.embed([params.queryText]);
    if (!queryVec) return [];
    const vecLiteral = toVectorLiteral(queryVec);
    const k = params.k ?? this.k;
    const decayFloor = new Date(params.barTs);
    decayFloor.setUTCMonth(decayFloor.getUTCMonth() - this.decayMonths);

    const rows = await this.db.$queryRaw<MemoryRow[]>`
      SELECT id, bar_ts, summary, outcome
      FROM agent_memory
      WHERE instrument = ${params.instrument}
        AND bar_ts <= ${params.barTs}
        AND bar_ts >= ${decayFloor}
        AND embedding_model = ${this.embeddings.model}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT ${k}`;

    if (rows.length > 0) {
      await this.db.$executeRaw`
        UPDATE agent_memory SET retrieval_count = retrieval_count + 1
        WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
    }
    return rows.map((r) => ({
      id: r.id,
      barTs: r.bar_ts.toISOString(),
      summary: r.summary,
      outcome: (r.outcome as Record<string, unknown> | null) ?? null,
    }));
  }

  /**
   * Phase-1 write (post-PM). Near-duplicate (cosine > threshold, same
   * instrument + embedding model) ⇒ merge: keep the existing row, point its
   * `signal_id` at the new signal so the next outcome update lands there.
   */
  async writeReflection(params: {
    instrument: string;
    barTs: Date;
    agentRole: AgentRole;
    signalId: string | null;
    summary: string;
  }): Promise<{ id: string; merged: boolean }> {
    const [vec] = await this.embeddings.embed([params.summary]);
    if (!vec) throw new Error('embedding provider returned no vector');
    const vecLiteral = toVectorLiteral(vec);

    const nearest = await this.db.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT id, 1 - (embedding <=> ${vecLiteral}::vector) AS similarity
      FROM agent_memory
      WHERE instrument = ${params.instrument}
        AND embedding_model = ${this.embeddings.model}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT 1`;

    const top = nearest[0];
    if (top && top.similarity > this.mergeThreshold) {
      await this.db.$executeRaw`
        UPDATE agent_memory
        SET signal_id = COALESCE(${params.signalId}::uuid, signal_id)
        WHERE id = ${top.id}::uuid`;
      return { id: top.id, merged: true };
    }

    const inserted = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO agent_memory (id, bar_ts, instrument, agent_role, signal_id, summary, embedding, embedding_model)
      VALUES (gen_random_uuid(), ${params.barTs}, ${params.instrument}, ${params.agentRole},
              ${params.signalId}::uuid, ${params.summary}, ${vecLiteral}::vector, ${this.embeddings.model})
      RETURNING id`;
    const id = inserted[0]?.id;
    if (!id) throw new Error('agent_memory insert returned no id');
    return { id, merged: false };
  }

  /** Phase-2 write: attach the realized outcome on trade close / expiry. */
  async recordOutcome(signalId: string, outcome: MemoryOutcome): Promise<number> {
    return this.db.$executeRaw`
      UPDATE agent_memory
      SET outcome = ${JSON.stringify(outcome)}::jsonb
      WHERE signal_id = ${signalId}::uuid`;
  }

  /**
   * Hygiene: max N memories per instrument — keep the most retrieved, then
   * the newest; evict the rest (relevance-weighted eviction, BE-064 AC).
   * Near-duplicate merging happens at write time (see writeReflection).
   */
  async enforceCap(instrument: string): Promise<number> {
    return this.db.$executeRaw`
      DELETE FROM agent_memory
      WHERE instrument = ${instrument}
        AND id NOT IN (
          SELECT id FROM agent_memory
          WHERE instrument = ${instrument}
          ORDER BY retrieval_count DESC, bar_ts DESC
          LIMIT ${this.instrumentCap}
        )`;
  }
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
