/**
 * BE-050/051/052 — execution worker process: execution queue, trade-manager,
 * reconciler, notifications. Run via `pnpm --filter @fx/node-api worker:execution`.
 */
import { type ConnectionOptions, Queue, type Telemetry, Worker } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../db.js';
import { loadEnv } from '../env.js';
import { touchExecutionHeartbeat } from '../execution/halt.js';
import { QuantExecutionClient } from '../execution/quant-client.js';
import { processExecutionJob } from './execution.js';
import { processNotificationJob } from './notifications.js';
import {
  EXECUTION_QUEUE,
  type ExecutionJob,
  NOTIFICATIONS_QUEUE,
  type NotificationJob,
  RECONCILIATION_QUEUE,
  SUPERVISION_QUEUE,
  type SupervisionJob,
  TRADE_MANAGER_QUEUE,
} from './queues.js';
import { processReconciliationJob } from './reconciler.js';
import { processTradeManagerJob } from './trade-manager.js';

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const bullConnection = connection as unknown as ConnectionOptions;
const prisma = createPrismaClient(env);
const quant = new QuantExecutionClient(env);

const telemetry: Telemetry | undefined = env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? new BullMQOtel('fx-execution-worker')
  : undefined;

const supervisionQueue = new Queue<SupervisionJob>(SUPERVISION_QUEUE, {
  connection: bullConnection,
  telemetry,
});
const notificationsQueue = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, {
  connection: bullConnection,
  telemetry,
});

const executionDeps = {
  prisma,
  redis: connection,
  quant,
  supervisionQueue,
  notificationsQueue,
  env,
};

const reconcilerDeps = {
  ...executionDeps,
  executionDeps,
  notificationsQueue,
};

const executionWorker = new Worker<ExecutionJob>(
  EXECUTION_QUEUE,
  async (job) => {
    await touchExecutionHeartbeat(connection);
    await processExecutionJob(executionDeps, job);
  },
  { connection: bullConnection, concurrency: 2, telemetry },
);

// Lifecycle visibility for the execution queue (dev debugging).
executionWorker.on('active', (job) => console.log(`[exec] active job ${job.id}`));
executionWorker.on('completed', (job) => console.log(`[exec] completed job ${job.id}`));
executionWorker.on('failed', (job, err) =>
  console.error(`[exec] FAILED job ${job?.id} attempt ${job?.attemptsMade}:`, err),
);
executionWorker.on('error', (err) => console.error('[exec] worker error:', err));
executionWorker.on('ready', () =>
  console.log(`[exec] worker ready — listening on '${EXECUTION_QUEUE}'`),
);

const tradeManagerWorker = new Worker(
  TRADE_MANAGER_QUEUE,
  async (job) => {
    await touchExecutionHeartbeat(connection);
    await processTradeManagerJob(job, executionDeps);
  },
  { connection: bullConnection, concurrency: 1, telemetry },
);

const reconciliationWorker = new Worker(
  RECONCILIATION_QUEUE,
  async (job) => {
    await touchExecutionHeartbeat(connection);
    await processReconciliationJob(job, { ...reconcilerDeps, env });
  },
  { connection: bullConnection, concurrency: 1, telemetry },
);

const notificationsWorker = new Worker<NotificationJob>(
  NOTIFICATIONS_QUEUE,
  async (job) => processNotificationJob(job, env),
  { connection: bullConnection, concurrency: 4, telemetry },
);

// Repeatable schedules (BE-051: 30s, BE-052: 60s)
const tradeManagerQueue = new Queue(TRADE_MANAGER_QUEUE, { connection: bullConnection, telemetry });
const reconciliationQueue = new Queue(RECONCILIATION_QUEUE, {
  connection: bullConnection,
  telemetry,
});

// BullMQ 5 forbids ':' in custom job ids.
await tradeManagerQueue.add('tick', {}, { repeat: { every: 30_000 }, jobId: 'trade-manager-tick' });
await reconciliationQueue.add(
  'tick',
  {},
  { repeat: { every: 60_000 }, jobId: 'reconciliation-tick' },
);

console.log(`@fx/node-api execution worker up (mode=${env.TRADING_MODE})`);

let shuttingDown = false;
const closeAll = async () => {
  await executionWorker.close();
  await tradeManagerWorker.close();
  await reconciliationWorker.close();
  await notificationsWorker.close();
  await supervisionQueue.close();
  await notificationsQueue.close();
  await tradeManagerQueue.close();
  await reconciliationQueue.close();
  connection.disconnect();
  await prisma.$disconnect();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeAll().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
