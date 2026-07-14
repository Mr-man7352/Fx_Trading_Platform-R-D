import {
  ApiErrorSchema,
  type ReplayAgentRun,
  type ReplayMemory,
  type ReplayQuantSection,
  SignalReplayResponseSchema,
  type SignalSummary,
  SignalsQuerySchema,
  SignalsResponseSchema,
} from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * BE-067 — signals REST: `GET /signals` returns recent quant candidates with
 * a compact agent-cycle summary (call/cost/roles from `agent_runs`, debate
 * turn count from `agent_debates`).
 *
 * QN-062/FE-060 — `GET /signals/:id/replay` reconstructs a past decision
 * ENTIRELY from stored provenance:
 *   - agent leg (LLM cached mode): `agent_runs.output` IS the cache — every
 *     call's provider/model/tier/downgrade provenance + parsed output, with
 *     the EXACT §9.5 memory context resolved via `retrieved_memory_ids`
 *     (BE-064), plus the full bull/bear/judge debate transcript (beyond the
 *     BE-067 summaries — this closes the FE-060 seam).
 *   - quant leg: proxied to the Python `POST /replay/quant`, which re-runs
 *     the deterministic pipeline point-in-time (side-effect-free) and
 *     reports feature/candidate drift. Quant service unreachable ⇒
 *     `quant.available: false` with the reason — the transcript still
 *     serves (honest seam, no fabricated determinism verdict).
 *
 * The live side of BE-067 needs no route: the signals worker publishes
 * `signal:*` events on the `signals` channel via the Redis WS fan-out
 * (ws-publish → ws-bridge → EventBus), so any WS client that sends
 * `{"type":"subscribe","data":{"channel":"signals"}}` receives debate events
 * as they happen (<500ms — one Redis pub/sub hop).
 */

export interface SignalsRouteDeps {
  /** Test seam for the quant REST call (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export function registerSignalsRoutes(app: FastifyInstance, deps: SignalsRouteDeps = {}): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const doFetch = deps.fetchImpl ?? fetch;

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

  typed.route({
    method: 'GET',
    url: '/signals/:id/replay',
    schema: {
      tags: ['signals'],
      summary: 'QN-062 — replay a past decision from stored provenance',
      params: z.object({ id: z.uuid() }),
      response: {
        200: SignalReplayResponseSchema,
        404: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const signal = await app.prisma.signal.findUnique({
        where: { id: req.params.id },
        include: {
          agentRuns: { orderBy: { createdAt: 'asc' } },
          debate: { orderBy: [{ round: 'asc' }, { seq: 'asc' }] },
        },
      });
      if (!signal) {
        return reply.code(404).send({
          error: { code: 'SIGNAL_NOT_FOUND', message: `no signal ${req.params.id}`, requestId: req.id },
        });
      }

      // Exact memory context (QN-062 AC): resolve every retrieved_memory_id
      // recorded on the runs — BE-064 pins what each agent actually saw.
      const memoryIds = [...new Set(signal.agentRuns.flatMap((r) => r.retrievedMemoryIds))];
      const memoryRows =
        memoryIds.length > 0
          ? await app.prisma.agentMemory.findMany({
              where: { id: { in: memoryIds } },
              select: {
                id: true,
                agentRole: true,
                barTs: true,
                summary: true,
                outcome: true,
                createdAt: true,
              },
            })
          : [];
      const memoryById = new Map<string, ReplayMemory>(
        memoryRows.map((m) => [
          m.id,
          {
            id: m.id,
            agentRole: m.agentRole,
            barTs: m.barTs.toISOString(),
            summary: m.summary,
            outcome: m.outcome ?? null,
            createdAt: m.createdAt.toISOString(),
          },
        ]),
      );

      const agentRuns: ReplayAgentRun[] = signal.agentRuns.map((run) => ({
        id: run.id,
        agentRole: run.agentRole,
        provider: run.provider,
        model: run.model,
        tier: run.tier,
        promptHash: run.promptHash,
        modelDowngraded: run.modelDowngraded,
        downgradeReason: run.downgradeReason,
        failedOver: run.failedOver,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: Number(run.costUsd),
        latencyMs: run.latencyMs,
        output: run.output ?? null,
        retrievedMemories: run.retrievedMemoryIds
          .map((id) => memoryById.get(id))
          // An evicted memory is reported as a tombstone, never dropped silently.
          .map(
            (m, i): ReplayMemory =>
              m ?? {
                id: run.retrievedMemoryIds[i] as string,
                agentRole: 'unknown',
                barTs: new Date(0).toISOString(),
                summary: '[memory evicted since the original run]',
                outcome: null,
                createdAt: new Date(0).toISOString(),
              },
          ),
        createdAt: run.createdAt.toISOString(),
      }));

      const quant = await quantReplay(doFetch, app.env.QUANT_HTTP_URL, {
        instrument: signal.instrument,
        timeframe: String(signal.timeframe),
        barTs: signal.barTs.toISOString(),
        features: signal.features ?? null,
        candidate: {
          side: String(signal.side),
          probability: signal.quantScore,
          entryPrice: signal.entryPrice === null ? null : Number(signal.entryPrice),
          stopLossPrice: signal.stopLoss === null ? null : Number(signal.stopLoss),
          takeProfitPrice: signal.takeProfit === null ? null : Number(signal.takeProfit),
          modelVersion: null, // schema gap: signals don't persist the model version
        },
      });

      return {
        signal: {
          id: signal.id,
          createdAt: signal.createdAt.toISOString(),
          barTs: signal.barTs.toISOString(),
          instrument: signal.instrument,
          timeframe: signal.timeframe,
          side: signal.side,
          entryPrice: signal.entryPrice === null ? null : Number(signal.entryPrice),
          stopLoss: signal.stopLoss === null ? null : Number(signal.stopLoss),
          takeProfit: signal.takeProfit === null ? null : Number(signal.takeProfit),
          probability: signal.quantScore,
          metaProbability: signal.metaProbability,
          status: signal.status,
          features: signal.features ?? null,
        },
        transcript: signal.debate.map((turn) => ({
          round: turn.round,
          seq: turn.seq,
          speaker: String(turn.speaker),
          content: turn.content,
        })),
        agentRuns,
        quant,
      };
    },
  });
}

/** Quant-leg replay via the Python service; failure ⇒ honest unavailable. */
async function quantReplay(
  doFetch: typeof fetch,
  quantUrl: string,
  body: Record<string, unknown>,
): Promise<ReplayQuantSection> {
  try {
    const res = await doFetch(`${quantUrl}/replay/quant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        available: false,
        detail: `quant replay answered ${res.status}: ${detail.slice(0, 500)}`,
        report: null,
      };
    }
    return { available: true, detail: null, report: await res.json() };
  } catch (err) {
    return {
      available: false,
      detail: err instanceof Error ? err.message : String(err),
      report: null,
    };
  }
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
