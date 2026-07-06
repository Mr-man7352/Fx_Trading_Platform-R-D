import {
  ApiErrorSchema,
  MarketCandlesQuerySchema,
  MarketCandlesResponseSchema,
  MarketInstrumentsResponseSchema,
  NewsPageSchema,
  NewsQuerySchema,
} from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { INSTRUMENTS, isKnownInstrument } from '../market/instruments.js';
import { MarketRepo } from '../market/repo.js';

/**
 * BE-045 — market REST: `GET /market/instruments` (static registry, always
 * available) and `GET /market/candles` (typed OHLCV, paginated). Plus the
 * BE-042 `GET /market/news` point-in-time archive read. DB-backed routes answer
 * 503 when the app was built without a Prisma client (unit tests / OpenAPI emit),
 * mirroring the audit route.
 */
export function registerMarketRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // BE-045 — instrument registry with broker symbol mappings (no DB needed).
  typed.route({
    method: 'GET',
    url: '/market/instruments',
    schema: {
      tags: ['market'],
      summary: 'List tradeable instruments and broker symbol mappings',
      response: { 200: MarketInstrumentsResponseSchema },
    },
    handler: async () => ({ instruments: [...INSTRUMENTS] }),
  });

  // BE-045 — paginated OHLCV candles.
  typed.route({
    method: 'GET',
    url: '/market/candles',
    schema: {
      tags: ['market'],
      summary: 'Query OHLCV candles for an instrument × timeframe',
      querystring: MarketCandlesQuerySchema,
      response: { 200: MarketCandlesResponseSchema, 400: ApiErrorSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const { instrument, timeframe, from, to, limit, includeIncomplete } = req.query;
      if (!isKnownInstrument(instrument)) {
        return reply.code(400).send({
          error: {
            code: 'UNKNOWN_INSTRUMENT',
            message: `Unknown instrument: ${instrument}`,
            requestId: req.id,
          },
        });
      }
      const repo = new MarketRepo(app.prisma);
      const candles = await repo.getCandles({
        instrument,
        timeframe,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit,
        includeIncomplete,
      });
      const last = candles.at(-1);
      const nextFrom =
        last && candles.length === limit
          ? new Date(new Date(last.ts).getTime() + 1).toISOString()
          : null;
      return { instrument, timeframe, candles, nextFrom };
    },
  });

  // BE-042 — point-in-time news archive read (published_at <= asOf).
  typed.route({
    method: 'GET',
    url: '/market/news',
    schema: {
      tags: ['market'],
      summary: 'Point-in-time news archive (no look-ahead)',
      querystring: NewsQuerySchema,
      response: { 200: NewsPageSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const { instrument, source, asOf, from, limit } = req.query;
      const repo = new MarketRepo(app.prisma);
      const items = await repo.queryNews({
        instrument,
        source,
        asOf: asOf ? new Date(asOf) : undefined,
        from: from ? new Date(from) : undefined,
        limit,
      });
      const lastItem = items.at(-1);
      const nextBefore = lastItem && items.length === limit ? lastItem.publishedAt : null;
      return { items, nextBefore };
    },
  });
}

function dbUnavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId },
  });
}
