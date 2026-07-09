import {
  ApiErrorSchema,
  type SignalSummary,
  SignalsQuerySchema,
  SignalsResponseSchema,
} from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * BE-067 — signals REST: `GET /signals` returns recent quant candidates with
 * a compact agent-cycle summary (call/cost/roles from `agent_runs`, debate
 * turn count from `agent_debates`).
 *
 * The live side of BE-067 needs no route: the signals worker publishes
 * `signal:*` events on the `signals` channel via the Redis WS fan-out
 * (ws-publish → ws-bridge → EventBus), so any WS client that sends
 * `{"type":"subscribe","data":{"channel":"signals"}}` receives debate events
 * as they happen (<500ms — one Redis pub/sub hop).
 */
export function registerSignalsRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/signals',
    schema: {
      tags: ['signals'],
      summary: 'Recent quant candidates with agent-cycle summaries',
      querystring: SignalsQuerySchema,
      response: { 200: SignalsResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const { instrument, status, limit } = req.query;
      const rows = await app.prisma.signal.findMany({
        where: {
          ...(instrument ? { instrument } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          agentRuns: {
            select: { agentRole: true, costUsd: true, modelDowngraded: true },
          },
          _count: { select: { debate: true } },
        },
      });
      const signals: SignalSummary[] = rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        barTs: row.barTs.toISOString(),
        instrument: row.instrument,
        timeframe: row.timeframe,
        side: row.side,
        entryPrice: row.entryPrice === null ? null : Number(row.entryPrice),
        stopLoss: row.stopLoss === null ? null : Number(row.stopLoss),
        takeProfit: row.takeProfit === null ? null : Number(row.takeProfit),
        probability: row.quantScore,
        status: row.status,
        agents: {
          llmCalls: row.agentRuns.length,
          costUsd: row.agentRuns.reduce((sum, r) => sum + Number(r.costUsd), 0),
          roles: [...new Set(row.agentRuns.map((r) => r.agentRole))].sort(),
          anyDowngraded: row.agentRuns.some((r) => r.modelDowngraded),
        },
        debateTurns: row._count.debate,
      }));
      return { signals };
    },
  });
}

function dbUnavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: {
      code: 'DB_UNAVAILABLE',
      message: 'Database is not configured for this instance',
      requestId,
    },
  });
}
