import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { MARKET_TICKS_QUEUE, SIGNALS_QUEUE } from '../workers/queues.js';

/**
 * BE-141 — `GET /metrics`: Prometheus text exposition, hand-rolled (no
 * prom-client dep for four gauges). Scraped by the observability profile's
 * Prometheus (infra/observability/prometheus.yml); the queue-depth gauges feed
 * the BE-141 alert rules (warning >10 for 2m, critical >25).
 *
 * Currently real: BullMQ queue depths + build info. LLM cost/latency, circuit
 * breaker state, and drawdown gauges are emitted by their owning stories
 * (BE-06x/BE-09x, Phases 2–3) under the metric names contracted in
 * infra/observability/README.md — panels/alerts are provisioned now and light
 * up as those land.
 *
 * Public (no internal token): bound to 127.0.0.1 in dev, private overlay
 * network in prod; exposes no user data.
 */
export function registerMetricsRoutes(app: FastifyInstance): void {
  const queues = new Map<string, Queue>();
  let redis: Redis | null = null;

  const getQueue = (name: string): Queue => {
    let q = queues.get(name);
    if (!q) {
      redis ??= new Redis(app.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        enableOfflineQueue: false, // fail scrapes fast when Redis is down
      });
      q = new Queue(name, { connection: redis as never });
      queues.set(name, q);
    }
    return q;
  };

  app.addHook('onClose', async () => {
    for (const q of queues.values()) await q.close();
    redis?.disconnect();
  });

  app.route({
    method: 'GET',
    url: '/metrics',
    config: { public: true },
    schema: { hide: true }, // not part of the OpenAPI surface
    handler: async (_req, reply) => {
      const lines: string[] = [
        '# HELP fx_build_info Build metadata (value is always 1).',
        '# TYPE fx_build_info gauge',
        `fx_build_info{commit="${app.env.GIT_COMMIT}",trading_mode="${app.env.TRADING_MODE}"} 1`,
        '# HELP fx_queue_jobs Jobs per BullMQ queue by state.',
        '# TYPE fx_queue_jobs gauge',
      ];
      let up = 1;
      for (const name of [SIGNALS_QUEUE, MARKET_TICKS_QUEUE]) {
        try {
          const c = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
          for (const [state, count] of Object.entries(c)) {
            lines.push(`fx_queue_jobs{queue="${name}",state="${state}"} ${count ?? 0}`);
          }
        } catch {
          up = 0; // Redis unreachable — report scrape degradation, not a 500
        }
      }
      lines.push(
        '# HELP fx_metrics_up 1 when all metric sources answered this scrape.',
        '# TYPE fx_metrics_up gauge',
        `fx_metrics_up ${up}`,
      );
      reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      return `${lines.join('\n')}\n`;
    },
  });
}
