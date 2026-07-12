/**
 * BE-080/081 — supervision worker process: layered exits + gated LLM
 * supervision on open trades. Run via
 * `pnpm --filter @fx/node-api worker:supervision` or the compose service.
 *
 * Queue layout (single SUPERVISION_QUEUE):
 *   - repeatable 'scan' job (SUPERVISION_INTERVAL_MS) enumerates open trades
 *     and enqueues one 'supervise' job per trade (deduped per tick), and
 *   - 'supervise' jobs run the BE-081 layers + BE-080 gate + LLM step.
 * The execution worker (BE-050) also enqueues 'supervise' directly on fill.
 */
import { LlmClient } from '@fx/llm';
import { type ConnectionOptions, Queue, type Telemetry, Worker } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../db.js';
import { loadEnv } from '../env.js';
import { type KillSwitchDb, KillSwitchStore } from '../execution/kill-switch.js';
import { QuantExecutionClient } from '../execution/quant-client.js';
import { PrismaLedgerSink, PrismaSpendProvider } from '../signals/llm-ledger.js';
import { createPromptRegistry } from '../signals/prompts.js';
import { processSupervisionJob, type SupervisionDeps } from '../supervision/supervision-worker.js';
import { SUPERVISION_QUEUE, type SupervisionJob } from './queues.js';
import { buildLlmAdapters } from './signals.js';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const bullConnection = connection as unknown as ConnectionOptions;
const prisma = createPrismaClient(env);
const quant = new QuantExecutionClient(env);

const telemetry: Telemetry | undefined = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? new BullMQOtel('fx-supervision-worker')
  : undefined;

const adapters = buildLlmAdapters(env);
const llm =
  Object.keys(adapters).length > 0
    ? new LlmClient({
        adapters,
        ledger: new PrismaLedgerSink(prisma),
        spend: new PrismaSpendProvider(prisma),
        monthlyCapUsd: env.LLM_MONTHLY_COST_CAP_USD,
      })
    : null;
if (!llm) {
  console.warn(
    '[supervision] NO LLM PROVIDER KEYS — layered exits + gate still run; material changes are audited without an LLM read',
  );
}

const killSwitch = new KillSwitchStore(prisma as unknown as KillSwitchDb, connection);
killSwitch.hydrate().catch((err) => {
  console.warn('[supervision] kill-switch boot hydration failed (retries on cache miss):', err);
});

const deps: SupervisionDeps = {
  prisma,
  redis: connection,
  quant,
  llm,
  registry: createPromptRegistry(),
  killSwitch,
  env,
};

const supervisionQueue = new Queue<SupervisionJob | Record<string, never>>(SUPERVISION_QUEUE, {
  connection: bullConnection,
  telemetry,
});

const worker = new Worker<SupervisionJob | Record<string, never>>(
  SUPERVISION_QUEUE,
  async (job) => {
    if (job.name === 'scan') {
      const open = await prisma.trade.findMany({ where: { status: 'open' }, select: { id: true } });
      for (const t of open) {
        await supervisionQueue.add(
          'supervise',
          { tradeId: t.id },
          // Dedupe within a tick window; new scans re-enqueue naturally.
          {
            jobId: `supervise-${t.id}-${Math.floor(Date.now() / env.SUPERVISION_INTERVAL_MS)}`,
            removeOnComplete: 500,
          },
        );
      }
      return;
    }
    const outcome = await processSupervisionJob(deps, job.data as SupervisionJob);
    console.log(
      `[supervision] trade=${(job.data as SupervisionJob).tradeId} → ${outcome.outcome}${outcome.layer ? ` (${outcome.layer})` : ''}${outcome.action ? ` (${outcome.action})` : ''}`,
    );
  },
  { connection: bullConnection, concurrency: 2, telemetry },
);

await supervisionQueue.add(
  'scan',
  {},
  { repeat: { every: env.SUPERVISION_INTERVAL_MS }, jobId: 'supervision-scan' },
);

console.log(
  `@fx/node-api supervision worker up (mode=${env.TRADING_MODE}, interval=${env.SUPERVISION_INTERVAL_MS}ms, llm=${llm ? 'on' : 'off'})`,
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.all([worker.close(), supervisionQueue.close()])
      .then(async () => {
        connection.disconnect();
        await prisma.$disconnect();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}
