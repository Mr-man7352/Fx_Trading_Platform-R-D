#!/usr/bin/env tsx
/**
 * BE-141 — deliberately backs up the `signals` queue to trip the queue-depth
 * alert rules (infra/observability/grafana/provisioning/alerting/alert-rules.yml):
 *
 *   warning  — sum(fx_queue_jobs{queue="signals",state=~"waiting|delayed"}) > 10  for 2m
 *   critical — same > 25 for 1m  → Telegram + SMS
 *
 * In Phase 2 nothing consumes the `signals` queue (market-data is a producer;
 * only trade-manager + reconciliation workers run), so enqueued jobs just sit
 * in `waiting` — no worker to pause. This script adds N such jobs and leaves
 * them there so Prometheus (15s scrape) sees the depth and Grafana fires after
 * the rule's `for:` window. Run with `--clean` afterwards to drain them so the
 * alert resolves (and you can confirm the resolve notification too).
 *
 * Usage:
 *   # 30 jobs → trips BOTH warning (>10) and critical (>25). Wait ~1-2 min.
 *   pnpm --filter @fx/node-api trip-signals
 *   # custom count (e.g. 15 → warning only):
 *   pnpm --filter @fx/node-api trip-signals -- 15
 *   # drain the backlog so the alert clears:
 *   pnpm --filter @fx/node-api trip-signals -- --clean
 *
 * NOTE: point this at the SAME Redis the scraped api reads. For the dockerised
 * stack, run it against the published port (REDIS_URL=redis://127.0.0.1:6379).
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../src/env.js';
import { SIGNALS_QUEUE, type SignalJob } from '../src/workers/queues.js';

const env = loadEnv();
const args = process.argv.slice(2).filter((a) => a !== '--');
const clean = args.includes('--clean');
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? '30');

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue<SignalJob>(SIGNALS_QUEUE, { connection: connection as never });

if (clean) {
  // obliterate() removes waiting/delayed/failed jobs and the queue keys.
  await queue.obliterate({ force: true });
  console.log(`Drained '${SIGNALS_QUEUE}' — backlog cleared; alert should resolve within a scrape or two.`);
} else {
  if (!Number.isInteger(count) || count < 1) {
    console.error('count must be a positive integer');
    process.exit(1);
  }
  // Unique jobId per job so BullMQ doesn't dedupe them into one.
  const jobs = Array.from({ length: count }, () => ({
    name: 'evaluate' as const,
    data: {
      instrument: 'EUR_USD',
      timeframe: 'H1',
      barTs: new Date().toISOString(),
    } satisfies SignalJob,
    opts: { jobId: `trip-${randomUUID()}` },
  }));
  await queue.addBulk(jobs);

  const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'failed');
  console.log(
    `Enqueued ${count} jobs into '${SIGNALS_QUEUE}' (no consumer in Phase 2 — they stay 'waiting').`,
  );
  console.log(`Queue now: ${JSON.stringify(counts)}`);
  console.log(
    count > 25
      ? 'Expect: warning fires after ~2m (>10), critical after ~1m (>25) → Telegram + SMS.'
      : count > 10
        ? 'Expect: warning only fires after ~2m (>10). Use 30+ to also trip the critical/SMS rule.'
        : 'Below the >10 warning threshold — pass a count >10 (or omit for 30) to actually trip a rule.',
  );
  console.log("When done, clear it: pnpm --filter @fx/node-api trip-signals -- --clean");
}

await queue.close();
connection.disconnect();
