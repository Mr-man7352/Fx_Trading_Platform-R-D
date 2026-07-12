import type { EmbeddingProvider } from '@fx/llm';
import type { AgentRole, RetrievedMemory } from '@fx/types';
import type { MemoryRetriever } from '../signals/context-assembler.js';

/**
 * QN-056 — backtest-local agent memory.
 *
 * The runner NEVER reads live `agent_memory` (story AC): memory starts EMPTY
 * at bar 0 and is rebuilt incrementally as the simulated run writes
 * reflections. Semantics mirror `AgentMemoryStore` (BE-064) exactly —
 * temporal filter `barTs <= currentBar`, instrument match, embedding-model
 * match, cosine top-K, write-time near-duplicate merge, outcome attach via
 * signalId — but everything lives in process memory, deterministically:
 * insertion order breaks ranking ties, no clocks, no I/O.
 */

interface StoredMemory {
  id: string;
  seq: number;
  barTs: Date;
  instrument: string;
  agentRole: AgentRole;
  signalId: string | null;
  summary: string;
  embedding: number[];
  embeddingModel: string;
  outcome: Record<string, unknown> | null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class InMemoryAgentMemory implements MemoryRetriever {
  private readonly rows: StoredMemory[] = [];
  private seq = 0;

  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly k = 5,
    private readonly mergeThreshold = 0.95,
  ) {}

  get size(): number {
    return this.rows.length;
  }

  /** §9.5 retrieval — hard temporal filter, deterministic ordering. */
  async retrieve(params: {
    instrument: string;
    barTs: Date;
    agentRole: AgentRole;
    queryText: string;
    k?: number;
  }): Promise<RetrievedMemory[]> {
    const [queryVec] = await this.embeddings.embed([params.queryText]);
    if (!queryVec) return [];
    const candidates = this.rows.filter(
      (r) =>
        r.instrument === params.instrument &&
        r.barTs.getTime() <= params.barTs.getTime() &&
        r.embeddingModel === this.embeddings.model,
    );
    const ranked = candidates
      .map((r) => ({ r, sim: cosineSimilarity(queryVec, r.embedding) }))
      // Deterministic: similarity desc, then insertion order (stable replay).
      .sort((a, b) => b.sim - a.sim || a.r.seq - b.r.seq)
      .slice(0, params.k ?? this.k);
    return ranked.map(({ r }) => ({
      id: r.id,
      barTs: r.barTs.toISOString(),
      summary: r.summary,
      outcome: r.outcome,
    }));
  }

  /** Mirrors AgentMemoryStore.writeReflection (merge > 0.95 same instrument). */
  async writeReflection(params: {
    instrument: string;
    barTs: Date;
    agentRole: AgentRole;
    signalId: string | null;
    summary: string;
  }): Promise<{ id: string; merged: boolean }> {
    const [vec] = await this.embeddings.embed([params.summary]);
    if (!vec) throw new Error('embedding provider returned no vector');

    let best: { row: StoredMemory; sim: number } | null = null;
    for (const row of this.rows) {
      if (row.instrument !== params.instrument || row.embeddingModel !== this.embeddings.model) {
        continue;
      }
      const sim = cosineSimilarity(vec, row.embedding);
      if (!best || sim > best.sim) best = { row, sim };
    }
    if (best && best.sim > this.mergeThreshold) {
      best.row.signalId = params.signalId ?? best.row.signalId;
      return { id: best.row.id, merged: true };
    }

    this.seq += 1;
    // Deterministic id — a pure function of run-local state, not randomness.
    const id = deterministicUuid(`${params.instrument}|${params.barTs.toISOString()}|${this.seq}`);
    this.rows.push({
      id,
      seq: this.seq,
      barTs: params.barTs,
      instrument: params.instrument,
      agentRole: params.agentRole,
      signalId: params.signalId,
      summary: params.summary,
      embedding: vec,
      embeddingModel: this.embeddings.model,
      outcome: null,
    });
    return { id, merged: false };
  }

  /** Outcome attach on simulated trade close (BE-064 phase-2 mirror). */
  async recordOutcome(signalId: string, outcome: Record<string, unknown>): Promise<number> {
    let updated = 0;
    for (const row of this.rows) {
      if (row.signalId === signalId) {
        row.outcome = outcome;
        updated += 1;
      }
    }
    return updated;
  }
}

/** RFC-4122-shaped deterministic id from a seed string (sha-free, tiny). */
export function deterministicUuid(seed: string): string {
  // FNV-1a 32-bit, run 4× with different offsets for 128 bits of spread.
  const part = (offset: number): string => {
    let h = 0x811c9dc5 ^ offset;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const hex = part(1) + part(2) + part(3) + part(5);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
