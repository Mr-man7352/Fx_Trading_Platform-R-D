import { HealthResponseSchema } from '@fx/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import type { Env } from '../env.js';
import { EXECUTION_HEARTBEAT_KEY } from '../execution/halt.js';

/** BE-010 — `GET /healthz`: `{ status, commit, uptime, tradingMode }`. */
export function registerHealthRoutes(app: FastifyInstance, env: Env): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/healthz',
    config: { public: true },
    schema: {
      tags: ['system'],
      summary: 'Liveness/readiness probe',
      security: [],
      response: { 200: HealthResponseSchema },
    },
    handler: async () => ({
      status: 'ok' as const,
      commit: env.GIT_COMMIT,
      uptime: process.uptime(),
      tradingMode: env.TRADING_MODE,
    }),
  });

  /** BE-053 — heartbeat includes execution worker last-seen (Redis). */
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/healthz/heartbeat',
    config: { public: true },
    schema: { hide: true },
    handler: async () => {
      const redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      let executionWorkerLastSeen: number | null = null;
      try {
        await redis.connect();
        const ts = await redis.get(EXECUTION_HEARTBEAT_KEY);
        executionWorkerLastSeen = ts ? Number(ts) : null;
      } catch {
        // Redis down — report null
      } finally {
        redis.disconnect();
      }
      const stale =
        executionWorkerLastSeen !== null && Date.now() - executionWorkerLastSeen > 120_000;
      return {
        status: stale ? 'degraded' : 'ok',
        commit: env.GIT_COMMIT,
        uptime: process.uptime(),
        tradingMode: env.TRADING_MODE,
        executionWorkerLastSeen,
      };
    },
  });
}
