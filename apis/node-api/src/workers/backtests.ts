import { FakeEmbeddingAdapter } from '@fx/llm';
import { type BacktestConfig, BacktestConfigSchema } from '@fx/types';
import {
  type AgenticRunnerDeps,
  reconcileQuantOnly,
  runAgenticBacktest,
} from '../backtest/agentic-runner.js';
import { InMemoryAgentMemory } from '../backtest/backtest-memory.js';
import { CachingLlmInvoker } from '../backtest/llm-cache.js';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { MarketRepo } from '../market/repo.js';
import type { LlmInvoker } from '../signals/agent-graph.js';
import { AgentGraph } from '../signals/agent-graph.js';
import { ContextAssembler } from '../signals/context-assembler.js';
import { createPromptRegistry } from '../signals/prompts.js';
import { QuantPipelineClient } from '../signals/quant-pipeline-client.js';
import type { BacktestJob } from './queues.js';
import { publishWsEvent } from './ws-publish.js';

/**
 * BE-090 — the backtests worker: executes one queued BacktestRun.
 *
 *   kind=quant   → POST {QUANT_HTTP_URL}/backtest/run (QN-050 engine; report
 *                  includes the QN-053 validation verdict + QN-054 ablations).
 *   kind=agentic → in-process QN-056 runner (same LangGraph code path,
 *                  TRADING_MODE=backtest). A quant-only agentic run ALSO
 *                  triggers the quant engine and attaches the reconciliation
 *                  report (QN-056 AC — correctness cross-check).
 */

export interface BacktestWorkerDeps {
  prisma: PrismaClient;
  redis: import('ioredis').Redis;
  env: Env;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable agentic deps builder (tests fake the pipeline/graph). */
  buildAgenticDeps?: (config: BacktestConfig) => AgenticRunnerDeps;
}

export async function runQuantEngine(
  deps: BacktestWorkerDeps,
  config: BacktestConfig,
  extras: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.env.QUANT_HTTP_URL}/backtest/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instrument: config.instrument,
      timeframe: config.timeframe,
      from: config.from,
      to: config.to,
      probability_threshold: config.probabilityThreshold,
      risk_pct: config.riskPct,
      initial_equity: config.initialEquity,
      run_validation: config.runValidation,
      run_ablations: config.runAblations,
      ...extras,
    }),
    signal: AbortSignal.timeout(deps.env.QUANT_BACKTEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`quant /backtest/run ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Default agentic wiring — real gRPC pipeline + the live BE-062 graph. */
export function defaultAgenticDeps(
  deps: BacktestWorkerDeps,
  config: BacktestConfig,
  live: LlmInvoker | null,
): AgenticRunnerDeps {
  const embeddings = new FakeEmbeddingAdapter(); // deterministic + keyless — reproducibility (QN-052)
  const memory = config.memoryEnabled ? new InMemoryAgentMemory(embeddings) : null;
  const repo = new MarketRepo(deps.prisma);
  const assembler = new ContextAssembler({
    news: {
      queryNews: async (params) => {
        const rows = await repo.queryNews({ ...params });
        return rows.map((r) => ({
          publishedAt: r.publishedAt,
          source: r.source,
          headline: r.headline,
          sentiment: r.sentiment ?? null,
        }));
      },
    },
    memory: memory ?? undefined,
  });
  const cache =
    config.mode === 'quant-only'
      ? null
      : new CachingLlmInvoker(config.mode, deps.env.LLM_CACHE_DIR, live);
  const graph =
    config.mode === 'quant-only' || !cache
      ? null
      : new AgentGraph({
          assembler,
          llm: cache,
          registry: createPromptRegistry(),
          probabilityThreshold: config.probabilityThreshold,
        });
  return {
    prisma: deps.prisma,
    pipeline: new QuantPipelineClient(deps.env),
    graph,
    assembler,
    cache,
    memory,
    env: deps.env,
  };
}

export async function processBacktestJob(
  deps: BacktestWorkerDeps,
  job: BacktestJob,
): Promise<'finished' | 'failed' | 'missing'> {
  const row = await deps.prisma.backtestRun.findUnique({ where: { id: job.backtestId } });
  if (!row) return 'missing';
  await deps.prisma.backtestRun.update({
    where: { id: row.id },
    data: { status: 'running', startedAt: new Date() },
  });

  try {
    const config = BacktestConfigSchema.parse(row.config);
    let metrics: Record<string, unknown>;
    let verdict: string | null = null;

    if (config.kind === 'quant') {
      const report = await runQuantEngine(deps, config);
      metrics = report;
      verdict = (report.validation as { verdict?: string } | undefined)?.verdict ?? null;
    } else {
      const agenticDeps = deps.buildAgenticDeps
        ? deps.buildAgenticDeps(config)
        : defaultAgenticDeps(deps, config, null);
      const result = await runAgenticBacktest(agenticDeps, {
        instrument: config.instrument,
        timeframe: config.timeframe,
        from: new Date(config.from),
        to: new Date(config.to),
        mode: config.mode,
        memoryEnabled: config.memoryEnabled,
        probabilityThreshold: config.probabilityThreshold,
        riskPct: config.riskPct,
        initialEquity: config.initialEquity,
        horizonBars: 24, // champion label horizon (LabelParams default)
        debateRounds: config.debateRounds,
      });
      metrics = { agentic: result } as Record<string, unknown>;

      if (config.mode === 'quant-only') {
        // QN-056 AC — reconcile the quant-only runner against the QN-050 engine.
        try {
          const engineReport = await runQuantEngine(deps, config);
          const reconciliation = reconcileQuantOnly(result, engineReport as never);
          metrics.engine = engineReport;
          metrics.reconciliation = reconciliation;
          verdict = (engineReport.validation as { verdict?: string } | undefined)?.verdict ?? null;
          if (!reconciliation.withinTolerance) {
            verdict = 'NOT VALIDATED';
            metrics.reconciliationNote =
              'quant-only runner drifted from the vectorbt engine — investigate before trusting agentic results';
          }
        } catch (err) {
          metrics.reconciliation = {
            withinTolerance: false,
            checks: { error: `engine unavailable: ${String(err)}` },
          };
        }
      }
    }

    await deps.prisma.backtestRun.update({
      where: { id: row.id },
      data: {
        status: 'finished',
        finishedAt: new Date(),
        metrics: metrics as never,
        validationVerdict: verdict,
      },
    });
    await publishWsEvent(deps.redis, 'backtests', {
      event: 'backtest:finished',
      payload: { id: row.id, verdict },
    });
    return 'finished';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.prisma.backtestRun.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        metrics: { error: message } as never,
      },
    });
    await publishWsEvent(deps.redis, 'backtests', {
      event: 'backtest:failed',
      payload: { id: row.id, error: message },
    });
    return 'failed';
  }
}
