/** BE-064 — memory store: temporal filter, model pinning, merge, cap, reflection. */

import { cosineSimilarity, EMBEDDING_DIMENSIONS, FakeEmbeddingAdapter } from '@fx/llm';
import type { SpecialistOutputs } from '@fx/types';
import { describe, expect, it } from 'vitest';
import type { AgentGraphResult } from './agent-graph.js';
import { AgentMemoryStore, composeReflection, type RawDb } from './agent-memory.js';
import { ContextAssembler, type NewsReader } from './context-assembler.js';
import type { PipelineResult } from './quant-pipeline-client.js';

// ─── Fake raw DB: records every query + parameters ───────────────────────────

interface Recorded {
  sql: string;
  values: unknown[];
}

function fakeDb(queryResults: unknown[][] = []) {
  const queries: Recorded[] = [];
  const executes: Recorded[] = [];
  let queryIdx = 0;
  const db: RawDb = {
    $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      queries.push({ sql: strings.join('?'), values });
      const result = queryResults[Math.min(queryIdx, queryResults.length - 1)] ?? [];
      queryIdx += 1;
      return result as T;
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executes.push({ sql: strings.join('?'), values });
      return 1;
    },
  };
  return { db, queries, executes };
}

const embeddings = new FakeEmbeddingAdapter();
const BAR_TS = new Date('2026-07-09T13:00:00.000Z');

// ─── Embeddings (seam sanity) ────────────────────────────────────────────────

describe('FakeEmbeddingAdapter', () => {
  it('is deterministic, 1536-dim, unit-norm', async () => {
    const [a, b] = await embeddings.embed(['same text', 'same text']);
    const [c] = await embeddings.embed(['different text']);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cosineSimilarity(a as number[], b as number[])).toBeCloseTo(1, 10);
    expect(Math.abs(cosineSimilarity(a as number[], c as number[]))).toBeLessThan(0.2);
    const norm = Math.sqrt((a as number[]).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ─── Retrieval ───────────────────────────────────────────────────────────────

describe('retrieve', () => {
  const row = {
    id: '7d9f9c2e-4b1a-4f7e-9a3c-2f6b8d1e5a90',
    bar_ts: new Date('2026-07-01T13:00:00.000Z'),
    summary: 'prior long worked',
    outcome: { rMultiple: 1.8 },
  };

  it('filters on instrument, bar_ts (no look-ahead), decay window, and PINNED model', async () => {
    const { db, queries } = fakeDb([[row]]);
    const store = new AgentMemoryStore(db, embeddings);
    const memories = await store.retrieve({
      instrument: 'EUR_USD',
      barTs: BAR_TS,
      agentRole: 'technical_analyst',
      queryText: 'query',
    });

    const sql = queries[0]?.sql ?? '';
    expect(sql).toContain('bar_ts <= ');
    expect(sql).toContain('bar_ts >= ');
    expect(sql).toContain('embedding_model = ');
    expect(sql).toContain('ORDER BY embedding <=>');
    expect(queries[0]?.values).toContain('EUR_USD');
    expect(queries[0]?.values).toContain('fake-embedding-v1');
    expect(queries[0]?.values).toContainEqual(BAR_TS);
    // decay floor = barTs - 18 months
    const decayFloor = queries[0]?.values.find((v) => v instanceof Date && v < BAR_TS) as Date;
    expect(decayFloor.toISOString()).toBe('2025-01-09T13:00:00.000Z');

    expect(memories).toEqual([
      {
        id: row.id,
        barTs: '2026-07-01T13:00:00.000Z',
        summary: 'prior long worked',
        outcome: { rMultiple: 1.8 },
      },
    ]);
  });

  it('bumps retrieval_count for returned ids (relevance-weighted eviction input)', async () => {
    const { db, executes } = fakeDb([[row]]);
    const store = new AgentMemoryStore(db, embeddings);
    await store.retrieve({
      instrument: 'EUR_USD',
      barTs: BAR_TS,
      agentRole: 'pm',
      queryText: 'query',
    });
    expect(executes[0]?.sql).toContain('retrieval_count = retrieval_count + 1');
    expect(executes[0]?.values[0]).toEqual([row.id]);
  });

  it('no rows → no update, empty result', async () => {
    const { db, executes } = fakeDb([[]]);
    const store = new AgentMemoryStore(db, embeddings);
    const memories = await store.retrieve({
      instrument: 'EUR_USD',
      barTs: BAR_TS,
      agentRole: 'pm',
      queryText: 'query',
    });
    expect(memories).toEqual([]);
    expect(executes).toHaveLength(0);
  });
});

// ─── Write + merge ───────────────────────────────────────────────────────────

describe('writeReflection', () => {
  const params = {
    instrument: 'EUR_USD',
    barTs: BAR_TS,
    agentRole: 'pm' as const,
    signalId: '3f2b8c1d-5e4a-4b7c-9d0e-1a2b3c4d5e6f',
    summary: 'EUR_USD H1 LONG — APPROVE',
  };

  it('inserts a new row with the pinned embedding model when nothing similar exists', async () => {
    const { db, queries } = fakeDb([
      [{ id: 'x', similarity: 0.4 }], // nearest-neighbour probe
      [{ id: 'new-id' }], // INSERT … RETURNING
    ]);
    const store = new AgentMemoryStore(db, embeddings);
    const result = await store.writeReflection(params);
    expect(result).toEqual({ id: 'new-id', merged: false });
    expect(queries[1]?.sql).toContain('INSERT INTO agent_memory');
    expect(queries[1]?.values).toContain('fake-embedding-v1');
    expect(queries[1]?.values).toContain(params.signalId);
  });

  it('merges into the existing row above the 0.95 threshold and re-points signal_id', async () => {
    const { db, queries, executes } = fakeDb([[{ id: 'existing-id', similarity: 0.97 }]]);
    const store = new AgentMemoryStore(db, embeddings);
    const result = await store.writeReflection(params);
    expect(result).toEqual({ id: 'existing-id', merged: true });
    expect(queries).toHaveLength(1); // no INSERT issued
    expect(executes[0]?.sql).toContain('SET signal_id');
    expect(executes[0]?.values).toContain(params.signalId);
  });

  it('exactly at the threshold does NOT merge (spec: cosine > 0.95)', async () => {
    const { db } = fakeDb([[{ id: 'existing-id', similarity: 0.95 }], [{ id: 'new-id' }]]);
    const store = new AgentMemoryStore(db, embeddings);
    const result = await store.writeReflection(params);
    expect(result.merged).toBe(false);
  });
});

describe('recordOutcome / enforceCap', () => {
  it('attaches the realized outcome by signal_id', async () => {
    const { db, executes } = fakeDb();
    const store = new AgentMemoryStore(db, embeddings);
    await store.recordOutcome('sig-1', { rMultiple: -1, exitReason: 'SL_HIT', holdingHours: 14 });
    expect(executes[0]?.sql).toContain('SET outcome = ');
    expect(executes[0]?.values[0]).toContain('"exitReason":"SL_HIT"');
    expect(executes[0]?.values[1]).toBe('sig-1');
  });

  it('evicts beyond the per-instrument cap, keeping most-retrieved then newest', async () => {
    const { db, executes } = fakeDb();
    const store = new AgentMemoryStore(db, embeddings, { instrumentCap: 500 });
    await store.enforceCap('EUR_USD');
    expect(executes[0]?.sql).toContain('DELETE FROM agent_memory');
    expect(executes[0]?.sql).toContain('ORDER BY retrieval_count DESC, bar_ts DESC');
    expect(executes[0]?.values).toContain(500);
  });
});

// ─── Reflection composer (deterministic — ADR-011 rationale) ────────────────

describe('composeReflection', () => {
  const emptyNews: NewsReader = { queryNews: async () => [] };

  function preparedCtx() {
    const result: PipelineResult = {
      features: { rsi_14: 61.2 },
      hasCandidate: true,
      candidate: {
        instrument: 'EUR_USD',
        side: 'long',
        probability: 0.63,
        regime: 'TREND_UP',
        modelVersion: 'v3',
        entryPrice: 1.0885,
        stopLossPrice: 1.0845,
        takeProfitPrice: 1.0965,
      },
      sessionLabel: 'LONDON',
      liquidityRegime: 'HIGH',
      trendRegime: 'TREND_UP',
      regimeEntropy: 0.41,
      debateRounds: 1,
      featureSetVersion: 1,
      challengerProbability: null,
    };
    const out = new ContextAssembler({ news: emptyNews }).prepare({
      result,
      instrument: 'EUR_USD',
      timeframe: 'H1',
      barTs: BAR_TS,
      configuredDebateRounds: 1,
    });
    if (!out.ok) throw new Error('prepare failed');
    return out.prepared;
  }

  const specialists: SpecialistOutputs = {
    technical: { stance: 'BULL', confidence: 0.7, rationale: 'trend intact' },
    macro: { stance: 'NEUTRAL', confidence: 0.5, rationale: 'mixed' },
    sentiment: { stance: 'BULL', confidence: 0.6, rationale: 'positive' },
  };

  const graphResult: AgentGraphResult = {
    decision: 'APPROVE',
    holdReason: null,
    holdDetail: null,
    specialists,
    transcript: [
      { round: 0, speaker: 'bull', argument: 'edge is real', confidence: 0.7 },
      { round: 0, speaker: 'bear', argument: 'entropy risk', confidence: 0.4 },
    ],
    notes: [],
    degradedRoles: [],
    tiebreakerApplied: false,
    tiebreakerOverrode: false,
    trader: { action: 'ENTER', direction: 'long', confidence: 0.66 },
    risk: { approve: true, concerns: ['event risk'] },
    digest: {
      stances: {
        technical: { stance: 'BULL', confidence: 0.7 },
        macro: { stance: 'NEUTRAL', confidence: 0.5 },
        sentiment: { stance: 'BULL', confidence: 0.6 },
      },
      finalRound: {
        bull: { argument: 'edge is real', confidence: 0.7 },
        bear: { argument: 'entropy risk', confidence: 0.4 },
      },
      traderAction: { action: 'ENTER', direction: 'long', confidence: 0.66 },
      riskConcerns: ['event risk'],
      tiebreakerApplied: false,
      degradedRoles: [],
    },
    pm: { decision: 'APPROVE', rationale: 'coherent case' },
    costUsd: 0.008,
    llmCalls: 8,
  };

  it('is deterministic and captures decision, stances, arguments, and concerns', () => {
    const a = composeReflection(preparedCtx(), graphResult);
    const b = composeReflection(preparedCtx(), graphResult);
    expect(a).toBe(b);
    expect(a).toContain('EUR_USD H1 LONG');
    expect(a).toContain('technical BULL (0.70)');
    expect(a).toContain('Bull (0.70): edge is real');
    expect(a).toContain('Trader: ENTER long');
    expect(a).toContain('Decision: APPROVE — coherent case');
    expect(a).toContain('concerns: event risk');
  });

  it('notes degradation and hold reasons', () => {
    const held: AgentGraphResult = {
      ...graphResult,
      decision: 'HOLD',
      holdReason: 'STAGE_TIMEOUT',
      pm: null,
      degradedRoles: ['macro_analyst'],
    };
    const text = composeReflection(preparedCtx(), held);
    expect(text).toContain('Decision: HOLD (STAGE_TIMEOUT)');
    expect(text).toContain('[degraded: macro_analyst]');
  });
});
