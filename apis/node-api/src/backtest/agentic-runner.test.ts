import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEmbeddingAdapter } from '@fx/llm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import type { AgentGraphResult } from '../signals/agent-graph.js';
import { ContextAssembler } from '../signals/context-assembler.js';
import type { PipelineResult, RunPipelineOutcome } from '../signals/quant-pipeline-client.js';
import {
  type AgenticBacktestConfig,
  type AgenticRunnerDeps,
  reconcileQuantOnly,
  runAgenticBacktest,
} from './agentic-runner.js';
import { InMemoryAgentMemory } from './backtest-memory.js';
import { CachingLlmInvoker } from './llm-cache.js';

/**
 * QN-056 — runner ACs with injected fakes:
 *   - refuses to run outside TRADING_MODE=backtest (single code path)
 *   - strictly sequential; gate_skip bars incur ZERO LLM/cache calls
 *   - deterministic: same config + cached-LLM + same state ⇒ bit-identical
 *   - memory rebuilt incrementally from empty (never read from live)
 *   - quant-only reconciliation helper
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  TRADING_MODE: 'backtest',
  RISK_PROBABILITY_THRESHOLD: 0.6,
  RISK_MAX_CONCURRENT_TRADES: 5,
  RISK_MAX_PER_CLUSTER: 2,
  RISK_CLUSTER_EXEMPTIONS: [],
  RISK_DAILY_DD_HALT_PCT: 0.05,
  RISK_WEEKLY_DD_HALT_PCT: 0.1,
  RISK_INSTRUMENT_DAILY_LOSS_PCT: 0.02,
  RISK_MIN_RR: 1.8,
  RISK_WEEKEND_FLATTEN_ENABLED: false,
  RISK_ROLLOVER_AUTOFLATTEN_XAU: false,
  AGENT_DEBATE_ROUNDS: 1,
} as unknown as Env;

// Tuesday 2026-07-07, hourly bars.
const START = new Date('2026-07-07T00:00:00Z');

function makeCandles(n: number, ohlc: (k: number) => [number, number, number, number]) {
  return Array.from({ length: n }, (_, k) => {
    const [open, high, low, close] = ohlc(k);
    return {
      instrument: 'EUR_USD',
      timeframe: 'H1',
      ts: new Date(START.getTime() + k * 3_600_000),
      open,
      high,
      low,
      close,
      volume: 100,
      complete: true,
    };
  });
}

/** Flat candles inside a 10-pip bracket except a TP spike at bar `tpBar`. */
function flatWithTp(n: number, tpBar: number) {
  return makeCandles(n, (k) =>
    k === tpBar ? [1.1, 1.103, 1.0995, 1.1015] : [1.1, 1.1005, 1.0995, 1.1],
  );
}

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    features: { atr_14: 0.001, rsi_14: 55, spread_pips: 1.0, spread_pctile: 0.4 },
    hasCandidate: true,
    candidate: {
      instrument: 'EUR_USD',
      side: 'long',
      probability: 0.66,
      regime: 'TREND_UP',
      modelVersion: 'v1',
      entryPrice: 1.1,
      stopLossPrice: 1.099,
      takeProfitPrice: 1.1025, // RR 2.5 — clears the min-RR rule net of costs
    },
    sessionLabel: 'LONDON',
    liquidityRegime: 'NORMAL',
    trendRegime: 'TREND_UP',
    regimeEntropy: 0.2,
    debateRounds: 1,
    featureSetVersion: 1,
    challengerProbability: null,
    ...overrides,
  };
}

function fakePrisma(candles: unknown[]) {
  return {
    candle: { findMany: async () => candles },
  } as never;
}

/** Pipeline fake: candidate on bar 0, nothing afterwards. */
function pipelineWithCandidateAtBar0(): {
  runPipeline: (i: string, t: string, barTs: Date) => Promise<RunPipelineOutcome>;
} {
  return {
    runPipeline: async (_i, _t, barTs) => {
      if (barTs.getTime() === START.getTime()) {
        return { kind: 'result', result: pipelineResult() };
      }
      return {
        kind: 'result',
        result: pipelineResult({ hasCandidate: false, candidate: null }),
      };
    },
  };
}

function assembler(memory?: InMemoryAgentMemory): ContextAssembler {
  return new ContextAssembler({
    news: { queryNews: async () => [] },
    memory,
  });
}

function graphResult(decision: 'APPROVE' | 'VETO' | 'HOLD'): AgentGraphResult {
  const specialist = { stance: 'BULL' as const, confidence: 0.7, rationale: 'test rationale' };
  return {
    decision,
    holdReason: null,
    holdDetail: null,
    specialists: { technical: specialist, macro: specialist, sentiment: specialist },
    transcript: [],
    notes: [],
    degradedRoles: [],
    tiebreakerApplied: false,
    tiebreakerOverrode: false,
    trader: { action: 'ENTER', direction: 'long', confidence: 0.7 },
    risk: { approve: true, concerns: [] },
    digest: null,
    pm: { decision, rationale: 'test pm rationale' },
    costUsd: 0,
    llmCalls: 0,
  };
}

function config(overrides: Partial<AgenticBacktestConfig> = {}): AgenticBacktestConfig {
  return {
    instrument: 'EUR_USD',
    timeframe: 'H1',
    from: START,
    to: new Date(START.getTime() + 100 * 3_600_000),
    mode: 'quant-only',
    memoryEnabled: false,
    probabilityThreshold: 0.6,
    riskPct: 0.01,
    initialEquity: 10_000,
    horizonBars: 24,
    ...overrides,
  };
}

function deps(overrides: Partial<AgenticRunnerDeps> = {}): AgenticRunnerDeps {
  return {
    prisma: fakePrisma(flatWithTp(10, 3)),
    pipeline: pipelineWithCandidateAtBar0(),
    graph: null,
    assembler: null,
    cache: null,
    memory: null,
    env: ENV,
    ...overrides,
  };
}

describe('runAgenticBacktest (QN-056)', () => {
  it('refuses to run unless TRADING_MODE=backtest (single code path)', async () => {
    await expect(
      runAgenticBacktest(deps({ env: { ...ENV, TRADING_MODE: 'paper' } as Env }), config()),
    ).rejects.toThrow(/TRADING_MODE=backtest/);
  });

  it('quant-only: enters on the candidate, exits at TP, reports gate stats', async () => {
    const result = await runAgenticBacktest(deps(), config());
    expect(result.gate.entries).toBe(1);
    expect(result.metrics.nTrades).toBe(1);
    expect(result.trades[0]?.exitReason).toBe('TP');
    expect(result.gate.gateSkips).toBeGreaterThan(0); // no-candidate bars
    expect(result.gate.gateSkipRate).toBeGreaterThan(0);
    expect(result.llm.calls).toBe(0);
    expect(result.llm.reproducible).toBe(true);
  });

  it('quant threshold rejects sub-threshold candidates (quantHolds)', async () => {
    const baseCandidate = pipelineResult().candidate;
    if (baseCandidate === null) throw new Error('expected default candidate');
    const pipeline = {
      runPipeline: async (): Promise<RunPipelineOutcome> => ({
        kind: 'result',
        result: pipelineResult({
          candidate: { ...baseCandidate, probability: 0.55 },
        }),
      }),
    };
    const result = await runAgenticBacktest(deps({ pipeline }), config());
    expect(result.gate.entries).toBe(0);
    expect(result.gate.quantHolds).toBeGreaterThan(0);
  });

  it('gate_skip bars incur ZERO LLM/cache calls even with the graph wired', async () => {
    const cache = new CachingLlmInvoker('cached-llm', tempDir(), null);
    const noCandidates = {
      runPipeline: async (): Promise<RunPipelineOutcome> => ({
        kind: 'result',
        result: pipelineResult({ hasCandidate: false, candidate: null }),
      }),
    };
    const graph = {
      run: async () => {
        throw new Error('graph must never fire on gate_skip bars');
      },
    };
    const result = await runAgenticBacktest(
      deps({ pipeline: noCandidates, graph, assembler: assembler(), cache }),
      config({ mode: 'cached-llm' }),
    );
    expect(result.gate.gateSkips).toBe(10);
    expect(cache.stats.calls).toBe(0);
    expect(result.llm.calls).toBe(0);
  });

  it('agent mode: PM APPROVE enters; memory is rebuilt incrementally from empty', async () => {
    const memory = new InMemoryAgentMemory(new FakeEmbeddingAdapter());
    const graph = { run: async () => graphResult('APPROVE') };
    const result = await runAgenticBacktest(
      deps({ graph, assembler: assembler(memory), memory }),
      config({ mode: 'cached-llm', memoryEnabled: true }),
    );
    expect(result.gate.entries).toBe(1);
    expect(result.memory.enabled).toBe(true);
    expect(result.memory.reflectionsWritten).toBe(1);
    expect(result.memory.finalSize).toBe(1);
    // Outcome attached on simulated close.
    const rows = await memory.retrieve({
      instrument: 'EUR_USD',
      barTs: new Date(START.getTime() + 50 * 3_600_000),
      agentRole: 'pm',
      queryText: 'anything',
    });
    expect(rows[0]?.outcome).toMatchObject({ exitReason: 'TP' });
  });

  it('agent mode: PM VETO blocks the entry and is counted', async () => {
    const graph = { run: async () => graphResult('VETO') };
    const result = await runAgenticBacktest(
      deps({ graph, assembler: assembler() }),
      config({ mode: 'cached-llm' }),
    );
    expect(result.gate.entries).toBe(0);
    expect(result.gate.pmVetoes).toBe(1);
    expect(result.metrics.nTrades).toBe(0);
  });

  it('same config + same state ⇒ bit-identical results (determinism AC)', async () => {
    const run = () =>
      runAgenticBacktest(
        deps({ graph: { run: async () => graphResult('APPROVE') }, assembler: assembler() }),
        config({ mode: 'cached-llm' }),
      );
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('reconcileQuantOnly (QN-056 AC)', () => {
  it('passes when trades and expectancy line up', async () => {
    const runner = await runAgenticBacktest(deps(), config());
    const engineReport = {
      metrics: { n_trades: 1, expectancy_r: runner.metrics.expectancyR ?? 0 },
      trades: [{ entry_ts: runner.trades[0]?.entryTs ?? '' }],
    };
    const rec = reconcileQuantOnly(runner, engineReport);
    expect(rec.withinTolerance).toBe(true);
  });

  it('fails on expectancy drift beyond tolerance', async () => {
    const runner = await runAgenticBacktest(deps(), config());
    const engineReport = {
      metrics: { n_trades: 1, expectancy_r: (runner.metrics.expectancyR ?? 0) + 1 },
      trades: [{ entry_ts: runner.trades[0]?.entryTs ?? '' }],
    };
    expect(reconcileQuantOnly(runner, engineReport).withinTolerance).toBe(false);
  });

  it('fails on disjoint entry sets', async () => {
    const runner = await runAgenticBacktest(deps(), config());
    const engineReport = {
      metrics: { n_trades: 1, expectancy_r: runner.metrics.expectancyR ?? 0 },
      trades: [{ entry_ts: '2020-01-01T00:00:00.000Z' }],
    };
    expect(reconcileQuantOnly(runner, engineReport).withinTolerance).toBe(false);
  });
});
