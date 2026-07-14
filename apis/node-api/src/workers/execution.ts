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
  /** BE-073 — Postgres-hydrated kill-switch (survives a Redis flush). */
  killSwitch?: import('../execution/kill-switch.js').KillSwitchStore | null;
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
  console.log(`[exec] job ${job.id} received intentId=${intentId}`);
  const intent = await deps.prisma.tradeIntent.findUnique({ where: { id: intentId } });
  if (!intent) {
    console.warn(`[exec] intent ${intentId} not found — nothing to do`);
    return;
  }
  console.log(
    `[exec] intent ${intentId} status=${intent.status} ${intent.side} ${intent.units} ${intent.instrument}`,
  );
  if (intent.status !== 'approved' && intent.status !== 'submitted') {
    console.log(`[exec] intent ${intentId} not actionable (status=${intent.status}) — skipping`);
    return; // idempotent — already terminal or in-flight handled
  }

  // Sticky Redis halt flag OR the Postgres-backed kill-switch (BE-073 — a
  // Redis flush re-hydrates from Postgres, never silently resumes trading).
  const halted =
    (await isExecutionHalted(deps.redis)) || (await deps.killSwitch?.isActive()) === true;
  if (halted) {
    console.warn(`[exec] execution HALTED — cancelling intent ${intentId}`);
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
    console.log(
      `[exec] → gRPC PlaceOrder target=${deps.env.QUANT_GRPC_URL} intent=${intentId} units=${Number(intent.units)}`,
    );
    result = await deps.quant.placeOrder({
      clientOrderId: intent.id,
      instrument: intent.instrument,
      side: orderSideFromIntent(intent.side),
      units: Number(intent.units),
      stopLossPrice: Number(intent.stopLoss),
      takeProfitPrice: intent.takeProfit ? Number(intent.takeProfit) : undefined,
    });
    console.log(
      `[exec] ← gRPC PlaceOrder ok intent=${intentId} status=${result.status} broker=${result.broker} tradeId=${result.brokerTradeId} filled=${result.filledUnits}@${result.fillPrice}`,
    );
  } catch (err) {
    if (isUnknownOutcome(err)) {
      // gRPC failed after send (quant service down / timeout) — outcome unknown.
      // Previously silent; log loudly so it's visible during testing.
      console.error(
        `[exec] gRPC PlaceOrder UNKNOWN OUTCOME intent=${intentId} — quant service unreachable at ${deps.env.QUANT_GRPC_URL}? Intent stays 'submitted' for the reconciler. err=${String(err)}`,
      );
      await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
        action: 'unknown_outcome',
        entityType: 'trade_intent',
        entityId: intentId,
        error: String(err),
      });
      return; // stays submitted — reconciler resolves
    }
    console.error(`[exec] gRPC PlaceOrder THREW intent=${intentId} — job will fail/retry`, err);
    throw err;
  }

  if (result.status === 'REJECTED') {
    console.warn(`[exec] order REJECTED intent=${intentId} reason=${result.reasonCode}`);
    await handleRejection(deps, intentId, result.reasonCode ?? 'REJECTED');
    return;
  }

  console.log(`[exec] order FILLED intent=${intentId} — persisting trade`);
  await handleFill(deps, intent, result);
  console.log(`[exec] done intent=${intentId}`);
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
  } else {
    // BE-115 — full-fill trade event (Telegram when configured).
    await notify(deps, {
      severity: 'info',
      title: 'Order filled',
      body: `${intent.instrument} ${intent.side} ${result.filledUnits} @ ${entryPrice} (SL ${Number(intent.stopLoss)}${intent.takeProfit ? `, TP ${Number(intent.takeProfit)}` : ''}) [${intent.tradingMode}]`,
      event: 'trade.fill',
    });
  }
}

export { EXECUTION_QUEUE };
