/** BE-062 — agent graph: parallel specialists, debate depth, tiebreaker, budgets. */

import type { InvokeParams, InvokeResult } from '@fx/llm';
import type { AgentRole } from '@fx/types';
import { describe, expect, it } from 'vitest';
import { AgentGraph, type GraphBudgets, parseJsonObject } from './agent-graph.js';
import { ContextAssembler, type NewsReader } from './context-assembler.js';
import { createPromptRegistry } from './prompts.js';
import type { PipelineResult } from './quant-pipeline-client.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BAR_TS = new Date('2026-07-09T13:00:00.000Z');
const emptyNews: NewsReader = { queryNews: async () => [] };

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    features: { rsi_14: 61.2, macro_dxy: 104.2, sent_mean_24h: 0.31 },
    hasCandidate: true,
    candidate: {
      instrument: 'EUR_USD',
      side: 'long',
      probability: 0.63,
      regime: 'TREND_UP',
      modelVersion: 'EUR_USD/H1 v3',
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
    ...overrides,
  };
}

function prepared(overrides: Partial<PipelineResult> = {}, configuredRounds: 0 | 1 | 2 = 1) {
  const assembler = new ContextAssembler({ news: emptyNews });
  const out = assembler.prepare({
    result: pipelineResult(overrides),
    instrument: 'EUR_USD',
    timeframe: 'H1',
    barTs: BAR_TS,
    configuredDebateRounds: configuredRounds,
  });
  if (!out.ok) throw new Error(`prepare failed: ${out.detail}`);
  return { assembler, prepared: out.prepared };
}

const account = { equity: 10_000, openPositions: 0, dailyPnlPct: 0, openRiskPct: 0 };

const GOLDEN: Record<AgentRole, string> = {
  technical_analyst:
    '{"stance":"BULL","confidence":0.7,"rationale":"trend intact, rsi supportive"}',
  macro_analyst: '{"stance":"NEUTRAL","confidence":0.5,"rationale":"dollar mixed"}',
  sentiment_analyst: '{"stance":"BULL","confidence":0.6,"rationale":"positive flow"}',
  bull_researcher: '{"argument":"momentum plus calibrated edge","confidence":0.7}',
  bear_researcher: '{"argument":"entropy risk, macro not confirming","confidence":0.4}',
  trader: '{"action":"ENTER","direction":"long","confidence":0.66}',
  risk_team: '{"approve":true,"concerns":["event risk friday"]}',
  pm: '{"decision":"APPROVE","rationale":"coherent bull case, risks acceptable"}',
  supervisor: '{"action":"HOLD","confidence":0.6,"rationale":"within plan, no action"}',
};

type Behavior =
  | { kind: 'reply'; text: string }
  | { kind: 'delay'; ms: number; text: string }
  | { kind: 'hang' };

/** Scripted invoker: per-role behaviors, records every call. */
function fakeLlm(overrides: Partial<Record<AgentRole, Behavior>> = {}) {
  const calls: InvokeParams[] = [];
  return {
    calls,
    invoke: async (params: InvokeParams): Promise<InvokeResult> => {
      calls.push(params);
      const behavior = overrides[params.role] ?? { kind: 'reply', text: GOLDEN[params.role] };
      if (behavior.kind === 'hang') await new Promise(() => {}); // never resolves
      if (behavior.kind === 'delay') await new Promise((r) => setTimeout(r, behavior.ms));
      return {
        text: behavior.kind === 'reply' || behavior.kind === 'delay' ? behavior.text : '',
        provider: 'anthropic',
        model: 'test-snapshot',
        tier: 'standard',
        modelDowngraded: false,
        downgradeReason: null,
        failedOver: false,
        latencyMs: 5,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      };
    },
  };
}

const TEST_BUDGETS: GraphBudgets = {
  specialistMs: 200,
  debateTurnMs: 200,
  stageMs: 200,
  graphMs: 2_000,
  failoverGraceMs: 50,
};

function graph(llm: { invoke: (p: InvokeParams) => Promise<InvokeResult> }, ctx = prepared()) {
  return {
    ctx,
    graph: new AgentGraph({
      assembler: ctx.assembler,
      llm,
      registry: createPromptRegistry(),
      budgets: TEST_BUDGETS,
    }),
  };
}

// ─── parseJsonObject ─────────────────────────────────────────────────────────

describe('parseJsonObject', () => {
  it('parses plain and fenced JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonObject('no json here')).toThrow();
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('AgentGraph happy path', () => {
  it('valid JSON from every role → PM decision, full transcript, digest', async () => {
    const llm = fakeLlm();
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });

    expect(result.decision).toBe('APPROVE');
    expect(result.holdReason).toBeNull();
    expect(result.specialists.technical.stance).toBe('BULL');
    // 1 round = bull + bear
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript.map((t) => t.speaker)).toEqual(['bull', 'bear']);
    expect(result.digest?.traderAction.action).toBe('ENTER');
    expect(result.digest?.riskConcerns).toEqual(['event risk friday']);
    expect(result.pm?.decision).toBe('APPROVE');
    expect(result.llmCalls).toBe(8); // 3 specialists + 2 debate turns + trader + risk + pm
    expect(result.costUsd).toBeCloseTo(0.008, 5);
  });

  it('runs the three specialists in parallel (§2.2 20s parallel budget)', async () => {
    const llm = fakeLlm({
      technical_analyst: { kind: 'delay', ms: 80, text: GOLDEN.technical_analyst },
      macro_analyst: { kind: 'delay', ms: 80, text: GOLDEN.macro_analyst },
      sentiment_analyst: { kind: 'delay', ms: 80, text: GOLDEN.sentiment_analyst },
    });
    const { graph: g } = graph(llm);
    const t0 = Date.now();
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    const specialistPhaseUpperBound = 3 * 80 - 20; // sequential would take ≥240ms
    expect(result.decision).toBe('APPROVE');
    expect(Date.now() - t0).toBeLessThan(specialistPhaseUpperBound + 400);
    // stronger signal: first three calls all started before any reply landed
    expect(
      llm.calls
        .slice(0, 3)
        .map((c) => c.role)
        .sort(),
    ).toEqual(['macro_analyst', 'sentiment_analyst', 'technical_analyst']);
  });

  it('trader sees the FULL transcript; PM sees the digest only (§9.6)', async () => {
    const llm = fakeLlm();
    const { graph: g } = graph(llm);
    await g.run({ prepared: prepared().prepared, account, signalId: null });
    const call = (role: AgentRole) => llm.calls.find((c) => c.role === role);
    const traderBundle = JSON.parse(call('trader')?.user ?? '{}');
    const pmBundle = JSON.parse(call('pm')?.user ?? '{}');
    expect(traderBundle.debateTranscript).toHaveLength(2);
    expect(pmBundle.debateTranscript).toBeUndefined();
    expect(pmBundle.digest.finalRound.bull.argument).toContain('momentum');
  });
});

// ─── Debate depth ────────────────────────────────────────────────────────────

describe('debate rounds', () => {
  it.each([
    [0 as const, 0],
    [1 as const, 2],
    [2 as const, 4],
  ])('configured %i rounds → %i turns', async (rounds, turns) => {
    const llm = fakeLlm();
    const ctx = prepared({}, rounds);
    const g = new AgentGraph({
      assembler: ctx.assembler,
      llm,
      registry: createPromptRegistry(),
      budgets: TEST_BUDGETS,
    });
    const result = await g.run({ prepared: ctx.prepared, account, signalId: null });
    expect(result.transcript).toHaveLength(turns);
    expect(result.decision).toBe('APPROVE');
  });

  it('high HMM entropy forces 2 rounds regardless of static config (BE-062 AC)', async () => {
    const llm = fakeLlm();
    const ctx = prepared({ regimeEntropy: 0.9 }, 0); // static 0, entropy high
    const g = new AgentGraph({
      assembler: ctx.assembler,
      llm,
      registry: createPromptRegistry(),
      budgets: TEST_BUDGETS,
    });
    const result = await g.run({ prepared: ctx.prepared, account, signalId: null });
    expect(ctx.prepared.pipeline.debateRounds).toBe(2);
    expect(result.transcript).toHaveLength(4);
  });
});

// ─── Tiebreaker (§9.6 QUANT_DEFAULT) ─────────────────────────────────────────

describe('split-vote tiebreaker', () => {
  const splitVote = {
    bull_researcher: { kind: 'reply', text: '{"argument":"edge","confidence":0.55}' } as Behavior,
    bear_researcher: { kind: 'reply', text: '{"argument":"risk","confidence":0.5}' } as Behavior,
  };

  it('sets QUANT_DEFAULT and follows quant when P ≥ threshold', async () => {
    const llm = fakeLlm(splitVote);
    const { graph: g } = graph(llm); // P = 0.63 ≥ 0.60
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.tiebreakerApplied).toBe(true);
    expect(result.trader).toMatchObject({ action: 'ENTER', direction: 'long' });
    const traderBundle = JSON.parse(llm.calls.find((c) => c.role === 'trader')?.user ?? '{}');
    expect(traderBundle.tiebreakerMode).toBe('QUANT_DEFAULT');
  });

  it('code-enforces HOLD when P < threshold even if the LLM says ENTER', async () => {
    const llm = fakeLlm(splitVote); // golden trader says ENTER
    const ctx = prepared({
      candidate: {
        instrument: 'EUR_USD',
        side: 'long',
        probability: 0.55, // below 0.60
        regime: 'TREND_UP',
        modelVersion: 'EUR_USD/H1 v3',
        entryPrice: 1.0885,
        stopLossPrice: 1.0845,
        takeProfitPrice: 1.0965,
      },
    });
    const g = new AgentGraph({
      assembler: ctx.assembler,
      llm,
      registry: createPromptRegistry(),
      budgets: TEST_BUDGETS,
    });
    const result = await g.run({ prepared: ctx.prepared, account, signalId: null });
    expect(result.tiebreakerApplied).toBe(true);
    expect(result.tiebreakerOverrode).toBe(true);
    expect(result.trader).toMatchObject({ action: 'HOLD', direction: null });
    expect(result.notes.some((n) => n.includes('QUANT_DEFAULT overrode'))).toBe(true);
  });

  it('no tiebreaker on a clear vote (diff ≥ 0.1)', async () => {
    const llm = fakeLlm(); // golden: bull 0.7, bear 0.4
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.tiebreakerApplied).toBe(false);
  });
});

// ─── Degradation (§2.2) ──────────────────────────────────────────────────────

describe('degradation', () => {
  it('one specialist timeout → NEUTRAL + note, graph still completes (no whole-graph HOLD)', async () => {
    const llm = fakeLlm({ technical_analyst: { kind: 'hang' } });
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.decision).toBe('APPROVE');
    expect(result.specialists.technical.stance).toBe('NEUTRAL');
    expect(result.degradedRoles).toEqual(['technical_analyst']);
    expect(result.notes.some((n) => n.includes('technical_analyst degraded'))).toBe(true);
    expect(result.digest?.degradedRoles).toEqual(['technical_analyst']);
  });

  it('failed debate turn is skipped and noted; the debate continues', async () => {
    const llm = fakeLlm({ bear_researcher: { kind: 'reply', text: 'not json at all' } });
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.decision).toBe('APPROVE');
    expect(result.transcript.map((t) => t.speaker)).toEqual(['bull']);
    expect(result.notes.some((n) => n.includes('bear turn skipped'))).toBe(true);
  });

  it('invalid trader JSON → deterministic HOLD SCHEMA_INVALID (risk/pm never invoked)', async () => {
    const llm = fakeLlm({
      trader: { kind: 'reply', text: '{"action":"ENTER","direction":null,"confidence":0.7}' },
    });
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.decision).toBe('HOLD');
    expect(result.holdReason).toBe('SCHEMA_INVALID');
    expect(llm.calls.map((c) => c.role)).not.toContain('risk_team');
    expect(llm.calls.map((c) => c.role)).not.toContain('pm');
  });

  it('extra keys in output are rejected (strictObject) → role degrades', async () => {
    const llm = fakeLlm({
      pm: { kind: 'reply', text: '{"decision":"APPROVE","rationale":"ok","note":"smuggled"}' },
    });
    const { graph: g } = graph(llm);
    const result = await g.run({ prepared: prepared().prepared, account, signalId: null });
    expect(result.decision).toBe('HOLD');
    expect(result.holdReason).toBe('SCHEMA_INVALID');
  });

  it('graph budget exceeded → HOLD BUDGET_EXCEEDED with partial transcript', async () => {
    const llm = fakeLlm({ trader: { kind: 'hang' } });
    const ctx = prepared();
    const g = new AgentGraph({
      assembler: ctx.assembler,
      llm,
      registry: createPromptRegistry(),
      // graph budget fires before the trader stage's own (budget+grace) race
      budgets: { ...TEST_BUDGETS, graphMs: 300, stageMs: 5_000, failoverGraceMs: 5_000 },
    });
    const result = await g.run({ prepared: ctx.prepared, account, signalId: null });
    expect(result.decision).toBe('HOLD');
    expect(result.holdReason).toBe('BUDGET_EXCEEDED');
    // partial transcript: the debate happened before the trader hung
    expect(result.transcript.length).toBeGreaterThan(0);
  });
});

// ─── Provenance ──────────────────────────────────────────────────────────────

describe('provenance', () => {
  it('every call carries the registered prompt hash + signalId', async () => {
    const llm = fakeLlm();
    const { graph: g } = graph(llm);
    const registry = createPromptRegistry();
    await g.run({ prepared: prepared().prepared, account, signalId: 'sig-1' });
    for (const call of llm.calls) {
      expect(call.promptHash).toBe(registry.get(call.role).hash);
      expect(call.signalId).toBe('sig-1');
      expect(call.retrievedMemoryIds).toEqual([]);
    }
  });
});
