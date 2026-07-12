/**
 * BE-090 — backtests worker process. Run via
 * `pnpm --filter @fx/node-api worker:backtests` or the compose service.
 *
 * Agentic runs require TRADING_MODE=backtest (the QN-056 runner refuses
 * otherwise — single code path, one mode flag). Quant runs merely proxy to
 * the quant service and work in any mode.
 */
import { LlmClient } from '@fx/llm';
import { type ConnectionOptions, type Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../db.js';
import { loadEnv } from '../env.js';
import { PrismaLedgerSink, PrismaSpendProvider } from '../signals/llm-ledger.js';
import { type BacktestWorkerDeps, defaultAgenticDeps, processBacktestJob } from './backtests.js';
import { BACKTESTS_QUEUE, type BacktestJob } from './queues.js';
import { buildLlmAdapters } from './signals.js';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prisma = createPrismaClient(env);

const adapters = buildLlmAdapters(env);
const live =
  Object.keys(adapters).length > 0
    ? new LlmClient({
        adapters,
        ledger: new PrismaLedgerSink(prisma),
        spend: new PrismaSpendProvider(prisma),
        monthlyCapUsd: env.LLM_MONTHLY_COST_CAP_USD,
      })
    : null;
if (!live) {
  console.warn(
    '[backtests] no LLM provider keys — live-llm mode unavailable; cached-llm replays only, cache misses will fail loudly',
  );
}

const deps: BacktestWorkerDeps = {
  prisma,
  redis: connection,
  env,
  buildAgenticDeps: (config) =>
    defaultAgenticDeps({ prisma, redis: connection, env }, config, live),
};

const worker = new Worker<BacktestJob>(
  BACKTESTS_QUEUE,
  async (job: Job<BacktestJob>) => {
    const outcome = await processBacktestJob(deps, job.data);
    console.log(`[backtests] ${job.data.backtestId} → ${outcome}`);
  },
  // One at a time: backtests are heavy and determinism beats throughput here.
  { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
);

console.log(`@fx/node-api backtests worker up (mode=${env.TRADING_MODE})`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker
      .close()
      .then(async () => {
        connection.disconnect();
        await prisma.$disconnect();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}
