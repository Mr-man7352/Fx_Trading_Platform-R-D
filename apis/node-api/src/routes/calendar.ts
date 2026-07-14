import { DEFAULT_RISK_GATE_CONFIG } from '@fx/risk-gate';
import {
  ApiErrorSchema,
  CalendarQuerySchema,
  type CalendarResponse,
  CalendarResponseSchema,
} from '@fx/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { lastCalendarFetch } from '../calendar/calendar-service.js';

/**
 * BE-110 — `GET /calendar`: upcoming economic events + provider freshness for
 * FE-101 (±30 min blackout shading). Answers 503 without a DB client, like
 * the audit route. The events come from the vendor-refreshed
 * `calendar_events` table (market-data worker owns the refresh job).
 */
export function registerCalendarRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/calendar',
    schema: {
      tags: ['market'],
      summary: 'Economic calendar events (vendor-refreshed; blackout window included)',
      querystring: CalendarQuerySchema,
      response: { 200: CalendarResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) {
        return reply.code(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId: req.id },
        });
      }
      const { from, to, impact, limit } = req.query;
      const now = Date.now();
      const fromTs = from ? new Date(from) : new Date(now - 12 * 3_600_000);
      const toTs = to ? new Date(to) : new Date(now + 7 * 24 * 3_600_000);

      const [rows, lastFetch] = await Promise.all([
        prisma.economicCalendarEvent.findMany({
          where: { ts: { gte: fromTs, lt: toTs }, ...(impact ? { impact } : {}) },
          orderBy: { ts: 'asc' },
          take: limit,
        }),
        lastCalendarFetch(prisma),
      ]);

      const available =
        lastFetch !== null && now - lastFetch.getTime() < app.env.CALENDAR_STALE_AFTER_MS;

      const body: CalendarResponse = {
        provider: app.env.CALENDAR_PROVIDER,
        available,
        lastFetchedAt: lastFetch ? lastFetch.toISOString() : null,
        blackoutMinutes: DEFAULT_RISK_GATE_CONFIG.blackoutMinutes,
        events: rows.map((r) => ({
          id: r.id,
          ts: r.ts.toISOString(),
          currency: r.currency,
          impact: (['high', 'medium', 'low'].includes(r.impact) ? r.impact : 'low') as
            | 'high'
            | 'medium'
            | 'low',
          title: r.title,
          source: r.source,
          forecast: r.forecast,
          previous: r.previous,
          actual: r.actual,
        })),
      };
      return body;
    },
  });
}
