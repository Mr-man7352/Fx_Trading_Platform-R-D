import {
  ApiErrorSchema,
  BacktestConfigSchema,
  BacktestCreateResponseSchema,
  BacktestListQuerySchema,
  BacktestListResponseSchema,
  type BacktestRun,
  BacktestRunSchema,
} from '@fx/types';
import type { Queue } from 'bullmq';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BacktestJob } from '../workers/queues.js';

/**
 * BE-090 — backtest trigger + results API.
 *
 *   POST /backtests      — validate config, persist a queued BacktestRun row,
 *                          enqueue the job (the backtests worker executes:
 *                          kind=quant → quant-service REST /backtest/run;
 *                          kind=agentic → in-process QN-056 runner).
 *   GET  /backtests      — recent runs (status filterable).
 *   GET  /backtests/:id  — full report: metrics, OOS split + validation
 *                          verdict (QN-053), ablation (QN-054), trades.
 */

export interface BacktestRouteDeps {
  queue: Queue<BacktestJob>;
}

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestRouteDeps | null): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'POST',
    url: '/backtests',
    schema: {
      tags: ['backtests'],
      summary: 'Queue a backtest (quant vectorbt engine or agentic runner)',
      body: BacktestConfigSchema,
      response: { 202: BacktestCreateResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma)
        return unavailable(reply, req.id, 'DB_UNAVAILABLE', 'Database not configured');
      if (!deps)
        return unavailable(reply, req.id, 'QUEUE_UNAVAILABLE', 'Backtest queue not configured');
      const run = await app.prisma.backtestRun.create({
        data: {
          status: 'queued',
          config: req.body as never,
          gitCommit: app.env.GIT_COMMIT,
        },
      });
      await deps.queue.add(
        'backtest',
        { backtestId: run.id },
        { jobId: `backtest-${run.id}`, removeOnComplete: 100 },
      );
      return reply.code(202).send({ id: run.id, status: 'queued' as const });
    },
  });

  typed.route({
    method: 'GET',
    url: '/backtests',
    schema: {
      tags: ['backtests'],
      summary: 'List recent backtest runs',
      querystring: BacktestListQuerySchema,
      response: { 200: BacktestListResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma)
        return unavailable(reply, req.id, 'DB_UNAVAILABLE', 'Database not configured');
      const rows = await app.prisma.backtestRun.findMany({
        where: req.query.status ? { status: req.query.status } : {},
        orderBy: { createdAt: 'desc' },
        take: req.query.limit,
      });
      // List view stays light: strip the (potentially huge) trade ledger.
      return { backtests: rows.map((r) => toApi(r, { includeTrades: false })) };
    },
  });

  typed.route({
    method: 'GET',
    url: '/backtests/:id',
    schema: {
      tags: ['backtests'],
      summary: 'Fetch one backtest run incl. metrics, validation verdict, ablation',
      params: z.object({ id: z.uuid() }),
      response: { 200: BacktestRunSchema, 404: ApiErrorSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma)
        return unavailable(reply, req.id, 'DB_UNAVAILABLE', 'Database not configured');
      const row = await app.prisma.backtestRun.findUnique({ where: { id: req.params.id } });
      if (!row) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `no backtest ${req.params.id}`, requestId: req.id },
        });
      }
      return toApi(row, { includeTrades: true });
    },
  });
}

interface BacktestRow {
  id: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: 'queued' | 'running' | 'finished' | 'failed';
  config: unknown;
  metrics: unknown;
  validationVerdict: string | null;
  gitCommit: string | null;
}

function toApi(row: BacktestRow, opts: { includeTrades: boolean }): BacktestRun {
  let metrics = (row.metrics as Record<string, unknown> | null) ?? null;
  if (metrics && !opts.includeTrades && 'trades' in metrics) {
    const { trades: _trades, ...rest } = metrics;
    metrics = rest;
  }
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status,
    config: (row.config as Record<string, unknown>) ?? {},
    metrics,
    validationVerdict: row.validationVerdict,
    gitCommit: row.gitCommit,
  };
}

function unavailable(reply: FastifyReply, requestId: string, code: string, message: string) {
  return reply.code(503).send({ error: { code, message, requestId } });
}
