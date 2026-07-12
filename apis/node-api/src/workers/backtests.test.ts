import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import type { RunPipelineOutcome } from '../signals/quant-pipeline-client.js';
import { type BacktestWorkerDeps, processBacktestJob } from './backtests.js';

/** BE-090 — worker execution paths with injected fakes. */

const ENV = {
  TRADING_MODE: 'backtest',
  QUANT_HTTP_URL: 'http://quant.test:5001',
  QUANT_BACKTEST_TIMEOUT_MS: 5_000,
  LLM_CACHE_DIR: 'var/llm-cache-test',
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

interface State {
  row: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
  published: Array<unknown>;
}

function makeDeps(state: State, overrides: Partial<BacktestWorkerDeps> = {}): BacktestWorkerDeps {
  const prisma = {
    backtestRun: {
      findUnique: async () => state.row,
      update: async (args: { data: Record<string, unknown> }) => {
        state.updates.push(args.data);
        return { ...state.row, ...args.data };
      },
    },
  };
  const redis = {
    publish: async (_ch: string, msg: string) => {
      state.published.push(JSON.parse(msg));
      return 1;
    },
  };
  return {
    prisma: prisma as never,
    redis: redis as never,
    env: ENV,
    ...overrides,
  };
}

const QUANT_CONFIG = {
  kind: 'quant',
  instrument: 'EUR_USD',
  timeframe: 'H1',
  from: '2026-01-05T00:00:00.000Z',
  to: '2026-03-27T00:00:00.000Z',
  probabilityThreshold: 0.6,
  riskPct: 0.01,
  initialEquity: 10_000,
  runValidation: true,
  runAblations: false,
  mode: 'quant-only',
  memoryEnabled: true,
};

describe('processBacktestJob (BE-090)', () => {
  it('returns missing for an unknown run id', async () => {
    const state: State = { row: null, updates: [], published: [] };
    expect(await processBacktestJob(makeDeps(state), { backtestId: 'x' })).toBe('missing');
  });

  it('kind=quant: proxies to the quant service and stores metrics + verdict', async () => {
    const state: State = {
      row: { id: 'r1', config: QUANT_CONFIG },
      updates: [],
      published: [],
    };
    const report = {
      engine: 'qn050-v1',
      metrics: { n_trades: 42 },
      validation: { verdict: 'VALIDATED' },
    };
    const fetchImpl = (async (url: string, init: { body: string }) => {
      expect(url).toBe('http://quant.test:5001/backtest/run');
      const body = JSON.parse(init.body);
      expect(body.probability_threshold).toBe(0.6);
      expect(body.run_validation).toBe(true);
      return {
        ok: true,
        json: async () => report,
      };
    }) as unknown as typeof fetch;

    const outcome = await processBacktestJob(makeDeps(state, { fetchImpl }), {
      backtestId: 'r1',
    });
    expect(outcome).toBe('finished');
    const final = state.updates.at(-1);
    expect(final?.status).toBe('finished');
    expect(final?.validationVerdict).toBe('VALIDATED');
    expect((final?.metrics as { engine: string }).engine).toBe('qn050-v1');
  });

  it('kind=quant: quant service failure marks the run failed with the error', async () => {
    const state: State = {
      row: { id: 'r2', config: QUANT_CONFIG },
      updates: [],
      published: [],
    };
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'no champion model',
    })) as unknown as typeof fetch;

    const outcome = await processBacktestJob(makeDeps(state, { fetchImpl }), {
      backtestId: 'r2',
    });
    expect(outcome).toBe('failed');
    const final = state.updates.at(-1);
    expect(final?.status).toBe('failed');
    expect((final?.metrics as { error: string }).error).toMatch(/no champion model/);
  });

  it('kind=agentic (quant-only): runs the runner AND attaches reconciliation', async () => {
    const start = new Date('2026-07-07T00:00:00Z');
    const candles = Array.from({ length: 6 }, (_, k) => ({
      ts: new Date(start.getTime() + k * 3_600_000),
      open: 1.1,
      high: k === 2 ? 1.103 : 1.1005,
      low: 1.0995,
      close: 1.1,
      complete: true,
    }));
    const state: State = {
      row: {
        id: 'r3',
        config: {
          ...QUANT_CONFIG,
          kind: 'agentic',
          from: start.toISOString(),
          // Window must cover the 6 generated candles AND satisfy from < to.
          to: new Date(start.getTime() + 6 * 3_600_000).toISOString(),
        },
      },
      updates: [],
      published: [],
    };
    const pipeline = {
      runPipeline: async (_i: string, _t: string, barTs: Date): Promise<RunPipelineOutcome> => ({
        kind: 'result',
        result: {
          features: { atr_14: 0.001 },
          hasCandidate: barTs.getTime() === start.getTime(),
          candidate:
            barTs.getTime() === start.getTime()
              ? {
                  instrument: 'EUR_USD',
                  side: 'long',
                  probability: 0.66,
                  regime: 'TREND_UP',
                  modelVersion: 'v1',
                  entryPrice: 1.1,
                  stopLossPrice: 1.099,
                  takeProfitPrice: 1.1025,
                }
              : null,
          sessionLabel: 'LONDON',
          liquidityRegime: 'NORMAL',
          trendRegime: 'TREND_UP',
          regimeEntropy: 0.2,
          debateRounds: 1,
          featureSetVersion: 1,
          challengerProbability: null,
        },
      }),
    };
    // Engine report that matches the runner's single TP trade closely enough.
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        metrics: { n_trades: 1, expectancy_r: 2.3 },
        trades: [{ entry_ts: start.toISOString() }],
        validation: { verdict: 'VALIDATED' },
      }),
    })) as unknown as typeof fetch;

    const deps = makeDeps(state, {
      fetchImpl,
      buildAgenticDeps: () => ({
        prisma: { candle: { findMany: async () => candles } } as never,
        pipeline,
        graph: null,
        assembler: null,
        cache: null,
        memory: null,
        env: ENV,
      }),
    });
    const outcome = await processBacktestJob(deps, { backtestId: 'r3' });
    expect(outcome).toBe('finished');
    const final = state.updates.at(-1);
    const metrics = final?.metrics as {
      agentic: { metrics: { nTrades: number } };
      reconciliation: { withinTolerance: boolean; checks: Record<string, unknown> };
    };
    expect(metrics.agentic.metrics.nTrades).toBe(1);
    expect(metrics.reconciliation).toBeDefined();
    expect(metrics.reconciliation.checks.entry_overlap).toBe(1);
  });
});
