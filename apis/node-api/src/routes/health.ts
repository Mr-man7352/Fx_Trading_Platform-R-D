import { HealthResponseSchema } from '@fx/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Env } from '../env.js';

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
}
