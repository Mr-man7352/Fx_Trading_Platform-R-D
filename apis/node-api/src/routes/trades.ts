import { ApiErrorSchema, type TradesListResponse, TradesListResponseSchema } from '@fx/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * BE-054 — trades REST (`GET /api/trades`). Closes the seam FE-070 has been
 * consuming through the typed api-client since Phase 1 (`trades.list` →
 * `/api/trades` — the path is preserved). Serves the current `TradeSchema`
 * draft shape; the richer record (SL/TP, realized/unrealized P&L, provenance
 * ids) extends the schema without breaking this endpoint.
 * Answers 503 without a DB client, like every data route.
 */
export function registerTradesRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/api/trades',
    schema: {
      tags: ['trades'],
      summary: 'List trades (open + closed, most recent first)',
      querystring: z.object({
        status: z.enum(['open', 'closed', 'cancelled']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      response: { 200: TradesListResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) {
        return reply.code(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId: req.id },
        });
      }
      const { status, limit } = req.query;
      const rows = await prisma.trade.findMany({
        where: status ? { status } : {},
        orderBy: { openedAt: 'desc' },
        take: limit,
      });
      const body: TradesListResponse = {
        trades: rows.map((t) => ({
          id: t.id,
          instrument: t.instrument,
          side: t.side,
          units: Number(t.units),
          mode: t.tradingMode,
          openedAt: t.openedAt.toISOString(),
          closedAt: t.closedAt ? t.closedAt.toISOString() : null,
        })),
      };
      return body;
    },
  });
}
