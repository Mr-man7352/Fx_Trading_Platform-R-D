import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { isExecutionHalted } from '../execution/halt.js';
import {
  isUnknownOutcome,
  type PlaceOrderResult,
  type QuantExecutionClient,
} from '../execution/quant-client.js';
import { EXECUTION_QUEUE, type NotificationJob, type SupervisionJob } from './queues.js';
import { writeWorkerAudit } from './worker-audit.js';
import { publishWsEvent } from './ws-publish.js';

/** BE-050 — process one execution job: place order, persist fill/reject. */

export interface ExecutionDeps {
  prisma: PrismaClient;
  redis: import('ioredis').Redis;
  quant: QuantExecutionClient;
  supervisionQueue: Queue<SupervisionJob>;
  notificationsQueue: Queue<NotificationJob>;
  env: Env;
}

function orderSideFromIntent(side: string): 'long' | 'short' {
  return side === 'short' ? 'short' : 'long';
}

async function notify(deps: ExecutionDeps, job: NotificationJob): Promise<void> {
  await deps.notificationsQueue.add('alert', job, { removeOnComplete: 100 });
}

export async function processExecutionJob(
  deps: ExecutionDeps,
  job: Job<{ intentId: string }>,
): Promise<void> {
  const { intentId } = job.data;
  const intent = await deps.prisma.tradeIntent.findUnique({ where: { id: intentId } });
  if (!intent) {
    console.warn(`execution: intent ${intentId} not found`);
    return;
  }
  if (intent.status !== 'approved' && intent.status !== 'submitted') {
    return; // idempotent — already terminal or in-flight handled
  }

  if (await isExecutionHalted(deps.redis)) {
    await deps.prisma.tradeIntent.update({
      where: { id: intentId },
      data: { status: 'cancelled', reasonCode: 'halted', decidedAt: new Date() },
    });
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'intent_cancelled_halt',
      entityType: 'trade_intent',
      entityId: intentId,
    });
    return;
  }

  if (intent.status === 'approved') {
    await deps.prisma.tradeIntent.update({
      where: { id: intentId },
      data: { status: 'submitted', decidedAt: new Date() },
    });
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'intent_submitted',
      entityType: 'trade_intent',
      entityId: intentId,
    });
  }

  let result: PlaceOrderResult;
  try {
    result = await deps.quant.placeOrder({
      clientOrderId: intent.id,
      instrument: intent.instrument,
      side: orderSideFromIntent(intent.side),
      units: Number(intent.units),
      stopLossPrice: Number(intent.stopLoss),
      takeProfitPrice: intent.takeProfit ? Number(intent.takeProfit) : undefined,
    });
  } catch (err) {
    if (isUnknownOutcome(err)) {
      await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
        action: 'unknown_outcome',
        entityType: 'trade_intent',
        entityId: intentId,
        error: String(err),
      });
      return; // stays submitted — reconciler resolves
    }
    throw err;
  }

  if (result.status === 'REJECTED') {
    await handleRejection(deps, intentId, result.reasonCode ?? 'REJECTED');
    return;
  }

  await handleFill(deps, intent, result);
}

async function handleRejection(
  deps: ExecutionDeps,
  intentId: string,
  reasonCode: string,
): Promise<void> {
  await deps.prisma.tradeIntent.update({
    where: { id: intentId },
    data: { status: 'rejected', reasonCode, decidedAt: new Date() },
  });
  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'intent_rejected',
    entityType: 'trade_intent',
    entityId: intentId,
    reasonCode,
  });
  await publishWsEvent(deps.redis, 'trade.fill', { intentId, status: 'rejected', reasonCode });
  await notify(deps, {
    severity: 'warning',
    title: 'Order rejected',
    body: `Intent ${intentId}: ${reasonCode}`,
    event: 'trade.rejected',
  });
}

async function handleFill(
  deps: ExecutionDeps,
  intent: {
    id: string;
    instrument: string;
    side: string;
    units: { toString(): string };
    entryPrice: { toString(): string } | null;
    stopLoss: { toString(): string };
    takeProfit: { toString(): string } | null;
    tradingMode: import('@fx/types').TradingMode;
  },
  result: PlaceOrderResult,
): Promise<void> {
  // Never derive risk from a missing fill price (a 0 entry would poison the
  // BE-051 R-multiple math) — the trade manager skips trades without
  // originalRiskDistance.
  const entryPrice = result.fillPrice ?? (intent.entryPrice ? Number(intent.entryPrice) : 0);
  const meta: Record<string, unknown> = {
    originalStopLoss: Number(intent.stopLoss),
  };
  if (entryPrice > 0) {
    meta.originalRiskDistance = Math.abs(entryPrice - Number(intent.stopLoss));
  }
  if (result.remainderUnits > 0) {
    meta.partialRemainder = result.remainderUnits;
  }

  const trade = await deps.prisma.trade.upsert({
    where: { intentId: intent.id },
    create: {
      intentId: intent.id,
      instrument: intent.instrument,
      side: intent.side as 'long' | 'short',
      units: result.filledUnits,
      entryPrice,
      stopLoss: Number(intent.stopLoss),
      takeProfit: intent.takeProfit ? Number(intent.takeProfit) : null,
      openedAt: new Date(),
      brokerTradeId: result.brokerTradeId,
      brokerOrderId: result.brokerOrderId,
      status: 'open',
      tradingMode: intent.tradingMode,
      meta: meta as never,
    },
    update: {
      brokerTradeId: result.brokerTradeId,
      brokerOrderId: result.brokerOrderId,
      units: result.filledUnits,
      entryPrice,
      meta: meta as never,
    },
  });

  await deps.prisma.tradeIntent.update({
    where: { id: intent.id },
    data: { status: 'executed', decidedAt: new Date() },
  });

  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: result.remainderUnits > 0 ? 'partial_fill' : 'fill',
    entityType: 'trade',
    entityId: trade.id,
    intentId: intent.id,
    remainderUnits: result.remainderUnits,
  });

  await deps.supervisionQueue.add(
    'open',
    { tradeId: trade.id },
    { jobId: `supervision-${trade.id}` }, // BullMQ 5 forbids ':' in custom ids
  );
  await publishWsEvent(deps.redis, 'trade.fill', {
    tradeId: trade.id,
    intentId: intent.id,
    instrument: intent.instrument,
    filledUnits: result.filledUnits,
    remainderUnits: result.remainderUnits,
    price: entryPrice,
  });

  if (result.remainderUnits > 0) {
    await notify(deps, {
      severity: 'warning',
      title: 'Partial fill',
      body: `${intent.instrument}: filled ${result.filledUnits}, remainder ${result.remainderUnits} (no auto-retry)`,
      event: 'trade.partial',
    });
  }
}

export { EXECUTION_QUEUE };
