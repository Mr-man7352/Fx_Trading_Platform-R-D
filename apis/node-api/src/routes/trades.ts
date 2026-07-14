import { ApiErrorSchema, type TradesListResponse, TradesListResponseSchema } from '@fx/types';
import type { Queue } from 'bullmq';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ExecutionJob } from '../workers/queues.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';
import { publishWsEvent } from '../workers/ws-publish.js';

/**
 * BE-054 — trades REST (`GET /api/trades`). Closes the seam FE-070 has been
 * consuming through the typed api-client since Phase 1 (`trades.list` →
 * `/api/trades` — the path is preserved). Serves the current `TradeSchema`
 * draft shape; the richer record (SL/TP, realized/unrealized P&L, provenance
 * ids) extends the schema without breaking this endpoint.
 * Answers 503 without a DB client, like every data route.
 *
 * BE-121 — canary one-tap confirm/reject for PENDING canary intents:
 *   POST /api/trades/intents/:id/confirm — approve + enqueue execution.
 *     410 Gone once CANARY_CONFIRM_TTL_MIN has elapsed (market moved on);
 *     the intent is cancelled with reason CANARY_CONFIRM_EXPIRED.
 *   POST /api/trades/intents/:id/reject  — cancel without execution.
 * ONLY intents parked by the canary ramp are confirmable (409 otherwise) —
 * this must never become a general "force-execute" backdoor.
 */

export interface TradesRouteDeps {
  /** Execution queue for confirmed canary intents (server.ts provides it). */
  executionQueue: Queue<ExecutionJob> | null;
  /** WS fan-out so the mobile safety card updates instantly (optional). */
  redis?: Redis | null;
}

const intentParams = z.object({ id: z.uuid() });

const canaryDecisionResponse = z.object({
  intentId: z.uuid(),
  status: z.string(),
  reasonCode: z.string().nullable(),
});

export function registerTradesRoutes(
  app: FastifyInstance,
  deps: TradesRouteDeps | null = null,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
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
      if (!prisma) return dbUnavailable(reply, req.id);
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

  // ─── BE-121 — canary confirm / reject ──────────────────────────────────────

  typed.route({
    method: 'POST',
    url: '/api/trades/intents/:id/confirm',
    schema: {
      tags: ['trades'],
      summary: 'BE-121 — one-tap confirm of a pending live canary intent',
      params: intentParams,
      response: {
        200: canaryDecisionResponse,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) return dbUnavailable(reply, req.id);
      if (!deps?.executionQueue) {
        return reply.code(503).send({
          error: {
            code: 'EXECUTION_QUEUE_UNAVAILABLE',
            message: 'execution queue not wired on this instance',
            requestId: req.id,
          },
        });
      }
      const intent = await prisma.tradeIntent.findUnique({ where: { id: req.params.id } });
      if (!intent) return intentNotFound(reply, req.id);
      const guardFailure = guardCanary(intent, reply, req.id);
      if (guardFailure) return guardFailure;

      // TTL: a stale confirm executes into a different market — expire it.
      const ageMin = (Date.now() - intent.createdAt.getTime()) / 60_000;
      if (ageMin > app.env.CANARY_CONFIRM_TTL_MIN) {
        await prisma.tradeIntent.update({
          where: { id: intent.id },
          data: {
            status: 'cancelled',
            reasonCode: 'CANARY_CONFIRM_EXPIRED',
            decidedAt: new Date(),
          },
        });
        await auditCanary(app, prisma, 'canary_confirm_expired', intent.id, { ageMin });
        return reply.code(410).send({
          error: {
            code: 'CANARY_CONFIRM_EXPIRED',
            message: `intent is ${ageMin.toFixed(1)} min old (TTL ${app.env.CANARY_CONFIRM_TTL_MIN} min) — cancelled`,
            requestId: req.id,
          },
        });
      }

      await prisma.tradeIntent.update({
        where: { id: intent.id },
        data: { status: 'approved', decidedAt: new Date() },
      });
      await deps.executionQueue.add(
        'execute-intent',
        { intentId: intent.id },
        { jobId: `intent-${intent.id}`, removeOnComplete: 1000 },
      );
      await auditCanary(app, prisma, 'canary_confirmed', intent.id, {
        instrument: intent.instrument,
        units: Number(intent.units),
      });
      if (deps.redis) {
        await publishWsEvent(deps.redis, 'signals', {
          event: 'signal:canary_confirmed',
          payload: { intentId: intent.id, instrument: intent.instrument },
        });
      }
      return { intentId: intent.id, status: 'approved', reasonCode: null };
    },
  });

  typed.route({
    method: 'POST',
    url: '/api/trades/intents/:id/reject',
    schema: {
      tags: ['trades'],
      summary: 'BE-121 — reject a pending live canary intent (no execution)',
      params: intentParams,
      response: {
        200: canaryDecisionResponse,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) return dbUnavailable(reply, req.id);
      const intent = await prisma.tradeIntent.findUnique({ where: { id: req.params.id } });
      if (!intent) return intentNotFound(reply, req.id);
      const guardFailure = guardCanary(intent, reply, req.id);
      if (guardFailure) return guardFailure;

      await prisma.tradeIntent.update({
        where: { id: intent.id },
        data: { status: 'rejected', reasonCode: 'CANARY_REJECTED', decidedAt: new Date() },
      });
      await auditCanary(app, prisma, 'canary_rejected', intent.id, {
        instrument: intent.instrument,
      });
      if (deps?.redis) {
        await publishWsEvent(deps.redis, 'signals', {
          event: 'signal:canary_rejected',
          payload: { intentId: intent.id, instrument: intent.instrument },
        });
      }
      return { intentId: intent.id, status: 'rejected', reasonCode: 'CANARY_REJECTED' };
    },
  });
}

function intentNotFound(reply: FastifyReply, requestId: string) {
  return reply.code(404).send({
    error: { code: 'INTENT_NOT_FOUND', message: 'no such trade intent', requestId },
  });
}

/** Shared guard: intent is pending AND was parked by the canary ramp.
 * Returns the error reply, or null when the intent is decidable. */
function guardCanary(
  intent: { id: string; status: string; riskGate: unknown },
  reply: FastifyReply,
  requestId: string,
): FastifyReply | null {
  if (intent.status !== 'pending') {
    return reply.code(409).send({
      error: {
        code: 'INTENT_NOT_PENDING',
        message: `intent is ${intent.status} — only pending canary intents are decidable`,
        requestId,
      },
    });
  }
  const canary = (intent.riskGate as { canary?: { confirmRequired?: boolean } } | null)?.canary;
  if (canary?.confirmRequired !== true) {
    return reply.code(409).send({
      error: {
        code: 'NOT_A_CANARY_INTENT',
        message: 'intent was not parked by the canary ramp — refusing (no force-execute backdoor)',
        requestId,
      },
    });
  }
  return null;
}

async function auditCanary(
  app: FastifyInstance,
  prisma: NonNullable<FastifyInstance['prisma']>,
  action: string,
  intentId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
    action,
    entityType: 'trade_intent',
    entityId: intentId,
    ...extra,
  });
}

function dbUnavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId },
  });
}
