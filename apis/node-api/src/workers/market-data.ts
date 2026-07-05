import type { DataQualityFlag } from '@fx/types';
import { type ConnectionOptions, type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { DataQualityMonitor, type DataQualitySink } from '../market/data-quality.js';
import { MarketDataProcessor } from '../market/processor.js';
import { MarketRepo } from '../market/repo.js';
import { DATA_QUALITY_CHANNEL, MARKET_TICKS_QUEUE, SIGNALS_QUEUE, type TickJob } from './queues.js';

/**
 * BE-040 — market-data BullMQ worker. Consumes ticks from `market-ticks`
 * (produced by the QN-020 OANDA stream), aggregates to M1 candles in
 * TimescaleDB via {@link MarketDataProcessor}, and enqueues a `signals` job on
 * every H1 close. Data-quality flags are fan-outed on a Redis channel so the
 * API/WS layer (and the Phase-3 risk gate) can surface degraded state.
 *
 * The pure aggregation lives in the processor; this file is the
 * infrastructure edge and is exercised end-to-end via `pnpm stack:up`.
 */

/** Publishes DQ flags to Redis; the API subscribes and re-emits over WS. */
class RedisDataQualitySink implements DataQualitySink {
  constructor(private readonly pub: Redis) {}
  record(flag: DataQualityFlag): void {
    void this.pub.publish(DATA_QUALITY_CHANNEL, JSON.stringify(flag));
  }
}

export interface MarketDataWorkerHandle {
  worker: Worker;
  close(): Promise<void>;
}

export function startMarketDataWorker(env: Env): MarketDataWorkerHandle {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // BullMQ bundles its own ioredis copy; passing our shared client trips a
  // cross-version structural check. The instance is API-compatible at runtime.
  const bullConnection = connection as unknown as ConnectionOptions;
  const prisma: PrismaClient = createPrismaClient(env);
  const repo = new MarketRepo(prisma);
  const monitor = new DataQualityMonitor(new RedisDataQualitySink(connection.duplicate()));
  const signals = new Queue(SIGNALS_QUEUE, { connection: bullConnection });

  const processor = new MarketDataProcessor(repo, monitor, async (t) => {
    await signals.add(
      'h1-close',
      { instrument: t.instrument, timeframe: t.timeframe, barTs: t.barTs.toISOString() },
      { jobId: `${t.instrument}:${t.timeframe}:${t.barTs.toISOString()}` }, // idempotent
    );
  });

  const worker = new Worker<TickJob>(
    MARKET_TICKS_QUEUE,
    async (job: Job<TickJob>) => {
      const { instrument, ts, bid, ask } = job.data;
      await processor.onTick(instrument, { ts: new Date(ts), bid, ask });
    },
    { connection: bullConnection, concurrency: 4 },
  );

  // Stale-feed sweep: a feed that goes quiet raises a degraded flag (QN-020).
  const staleTimer = setInterval(() => processor.checkStale(new Date()), 10_000);
  staleTimer.unref();

  return {
    worker,
    async close() {
      clearInterval(staleTimer);
      await worker.close();
      await signals.close();
      connection.disconnect();
      await prisma.$disconnect();
    },
  };
}
