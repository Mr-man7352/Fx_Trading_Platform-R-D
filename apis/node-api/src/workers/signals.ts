import {
  AnthropicAdapter,
  FakeEmbeddingAdapter,
  GeminiAdapter,
  LlmClient,
  OpenAiAdapter,
  OpenAiEmbeddingAdapter,
  OpenRouterAdapter,
  type ProviderAdapter,
  type ProviderName,
} from '@fx/llm';
import { type ConnectionOptions, type Job, Queue, type Telemetry, Worker } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { type KillSwitchDb, KillSwitchStore } from '../execution/kill-switch.js';
import { MarketRepo } from '../market/repo.js';
import { DbAccountStateProvider } from '../signals/account-state.js';
import { AgentGraph, H1_BUDGETS } from '../signals/agent-graph.js';
import { AgentMemoryStore } from '../signals/agent-memory.js';
import { ContextAssembler } from '../signals/context-assembler.js';
import { PrismaLedgerSink, PrismaSpendProvider } from '../signals/llm-ledger.js';
import { createPromptRegistry } from '../signals/prompts.js';
import { QuantPipelineClient } from '../signals/quant-pipeline-client.js';
import { DeterministicRiskGate } from '../signals/risk-gate.js';
import {
  PrioritySemaphore,
  processSignalJob,
  type SignalsWorkerDeps,
  sweepTradeOutcomes,
} from '../signals/signals-worker.js';
import { EXECUTION_QUEUE, NOTIFICATIONS_QUEUE, SIGNALS_QUEUE, type SignalJob } from './queues.js';

/**
 * BE-066 — signals worker bootstrap: builds the LLM client from configured
 * env keys (keyless providers are absent from the failover chain), the
 * embedding provider (env-configurable, fake by default for keyless dev),
 * the memory store (or null in ablation mode), and consumes the `signals`
 * queue that market-data has been producing since Phase 2.
 *
 * BullMQ `concurrency` is set ABOVE the graph cap on purpose: jobs enter
 * `processSignalJob` immediately (cheap gRPC + gate work), and the §9.6
 * PrioritySemaphore (cap 3) gates only the expensive LangGraph section —
 * that is where the E2E clock contractually starts.
 */

export function buildLlmAdapters(env: Env): Partial<Record<ProviderName, ProviderAdapter>> {
  const adapters: Partial<Record<ProviderName, ProviderAdapter>> = {};
  if (env.ANTHROPIC_API_KEY) adapters.anthropic = new AnthropicAdapter(env.ANTHROPIC_API_KEY);
  if (env.OPENROUTER_API_KEY) adapters.openrouter = new OpenRouterAdapter(env.OPENROUTER_API_KEY);
  if (env.OPENAI_API_KEY) adapters.openai = new OpenAiAdapter(env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) adapters.gemini = new GeminiAdapter(env.GEMINI_API_KEY);
  return adapters;
}

export interface SignalsWorkerHandle {
  worker: Worker;
  close(): Promise<void>;
}

export function startSignalsWorker(env: Env): SignalsWorkerHandle {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const bullConnection = connection as unknown as ConnectionOptions;
  const prisma: PrismaClient = createPrismaClient(env);
  const telemetry: Telemetry | undefined = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new BullMQOtel('fx-node-api')
    : undefined;

  const adapters = buildLlmAdapters(env);
  if (Object.keys(adapters).length === 0) {
    // Deterministic degradation, not a crash: every graph stage will fail
    // provider-exhausted ⇒ HOLD. Loud so a paper run can't silently no-op.
    console.warn(
      '[signals] NO LLM PROVIDER KEYS CONFIGURED — every agent cycle will HOLD (PROVIDER_EXHAUSTED)',
    );
  }
  const llm = new LlmClient({
    adapters,
    ledger: new PrismaLedgerSink(prisma),
    spend: new PrismaSpendProvider(prisma),
    monthlyCapUsd: env.LLM_MONTHLY_COST_CAP_USD,
  });

  const embeddings =
    env.EMBEDDING_PROVIDER === 'openai' && env.OPENAI_API_KEY
      ? new OpenAiEmbeddingAdapter(env.OPENAI_API_KEY, env.EMBEDDING_MODEL)
      : new FakeEmbeddingAdapter();
  if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    console.warn(
      '[signals] EMBEDDING_PROVIDER=openai but no OPENAI_API_KEY — using fake embeddings',
    );
  }
  const memory = env.AGENT_MEMORY_ENABLED ? new AgentMemoryStore(prisma, embeddings) : null;

  const repo = new MarketRepo(prisma);
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

  const pipeline = new QuantPipelineClient(env);
  const graph = new AgentGraph({
    assembler,
    llm,
    registry: createPromptRegistry(),
    budgets: { ...H1_BUDGETS, graphMs: env.SIGNALS_GRAPH_BUDGET_MS },
    probabilityThreshold: env.RISK_PROBABILITY_THRESHOLD,
  });

  // BE-073 — Postgres-hydrated kill-switch state (Redis is cache only).
  // Re-hydrate on BOOT (story AC) as well as on every cache miss.
  const killSwitch = new KillSwitchStore(prisma as unknown as KillSwitchDb, connection);
  killSwitch.hydrate().catch((err) => {
    console.warn('[signals] kill-switch boot hydration failed (will retry on cache miss):', err);
  });

  const deps: SignalsWorkerDeps = {
    prisma,
    redis: connection,
    pipeline,
    assembler,
    graph,
    // BE-070/071 — the real deterministic rule engine (final authority, §10).
    riskGate: new DeterministicRiskGate(prisma, killSwitch, env),
    killSwitch,
    account: new DbAccountStateProvider(prisma, env.ACCOUNT_BASELINE_EQUITY),
    memory,
    executionQueue: new Queue(EXECUTION_QUEUE, { connection: bullConnection, telemetry }),
    notificationsQueue: new Queue(NOTIFICATIONS_QUEUE, { connection: bullConnection, telemetry }),
    semaphore: new PrioritySemaphore(env.SIGNALS_GRAPH_CONCURRENCY),
    env,
  };

  const worker = new Worker<SignalJob>(
    SIGNALS_QUEUE,
    async (job: Job<SignalJob>) => {
      const outcome = await processSignalJob(deps, job.data);
      console.log(
        `[signals] ${job.data.instrument} ${job.data.timeframe} ${job.data.barTs} → ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}`,
      );
    },
    // Above the graph cap: the semaphore (not BullMQ) is the §9.6 limiter.
    { connection: bullConnection, concurrency: env.SIGNALS_GRAPH_CONCURRENCY * 2, telemetry },
  );

  // BE-064 phase-2: attach realized outcomes to reflections on trade close.
  let lastSweep = new Date(Date.now() - 60 * 60_000);
  const sweepTimer = setInterval(async () => {
    if (!memory) return;
    try {
      const from = lastSweep;
      lastSweep = new Date();
      await sweepTradeOutcomes(prisma, memory, from);
    } catch (err) {
      console.warn('[signals] outcome sweep failed:', err);
    }
  }, 60_000);
  sweepTimer.unref();

  return {
    worker,
    async close() {
      clearInterval(sweepTimer);
      await worker.close();
      await deps.executionQueue.close();
      await deps.notificationsQueue.close();
      connection.disconnect();
      await prisma.$disconnect();
    },
  };
}
