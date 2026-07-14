import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { setExecutionHalt } from '../execution/halt.js';
import type { QuantExecutionClient, TradeReduce } from '../execution/quant-client.js';
import { type ExecutionDeps, processExecutionJob } from './execution.js';
import type { NotificationJob } from './queues.js';
import { writeWorkerAudit } from './worker-audit.js';
import { publishWsEvent } from './ws-publish.js';

/** BE-052 — 60s broker ↔ DB reconciler. */

const RECONCILER_TXN_KEY = 'reconciler:since_txn_id';

export interface ReconcilerDeps {
  prisma: PrismaClient;
  redis: import('ioredis').Redis;
  quant: QuantExecutionClient;
  notificationsQueue: Queue<NotificationJob>;
  executionDeps: ExecutionDeps;
  env: Env;
}

export interface ReconcileMetrics {
  recordMismatch(): void;
}

export async function processReconciliationTick(
  deps: ReconcilerDeps,
  metrics?: ReconcileMetrics,
): Promise<void> {
  const sinceTxnId = (await deps.redis.get(RECONCILER_TXN_KEY)) ?? '';
  const { transactions, lastTxnId } = await deps.quant.getTransactions(sinceTxnId || undefined);
  // Always persist the high-water mark — the quant service returns its
  // connect-time bootstrap id even when no transactions arrived, so the very
  // first tick establishes a real since-id (BE-052 bootstrap).
  if (lastTxnId) await deps.redis.set(RECONCILER_TXN_KEY, lastTxnId);

  for (const tx of transactions) {
    if (tx.type !== 'ORDER_FILL') continue;

    // Fill for a submitted intent that lost its gRPC response → complete the
    // BE-050 persistence path (adapter's duplicate-recovery makes this safe).
    if (tx.clientOrderId) {
      const intent = await deps.prisma.tradeIntent.findUnique({
        where: { id: tx.clientOrderId },
      });
      if (intent?.status === 'submitted') {
        await processExecutionJob(deps.executionDeps, {
          data: { intentId: intent.id },
        } as Job<{ intentId: string }>);
      }
    }

    // Broker-side closes live ONLY in tradesClosed/tradeReduced — real
    // ORDER_FILL transactions never carry a top-level tradeID (SL/TP hits
    // arrive here as fills with reason STOP_LOSS_ORDER / TAKE_PROFIT_ORDER).
    const closedUnits =
      tx.tradesClosed.reduce((sum, tc) => sum + tc.units, 0) + (tx.tradeReduced?.units ?? 0);
    for (const tc of tx.tradesClosed) {
      const commissionShare =
        closedUnits > 0 ? Math.abs(tx.commission ?? 0) * (tc.units / closedUnits) : 0;
      await syncFullClose(deps, tc, tx.reason, commissionShare);
    }
    if (tx.tradeReduced) {
      const tr = tx.tradeReduced;
      const commissionShare =
        closedUnits > 0 ? Math.abs(tx.commission ?? 0) * (tr.units / closedUnits) : 0;
      await syncPartialClose(deps, tr, tx.reason, commissionShare);
    }
  }

  const brokerPositions = await deps.quant.listOpenPositions();
  const dbTrades = await deps.prisma.trade.findMany({ where: { status: 'open' } });
  const mismatches = detectMismatches(brokerPositions, dbTrades);

  if (mismatches.length > 0) {
    const { incrementReconcileMismatchMetric } = await import('../execution/halt.js');
    await incrementReconcileMismatchMetric(deps.redis);
    metrics?.recordMismatch();
    await handleMismatches(deps, mismatches);
  }
}

/** Broker fully closed a trade (SL/TP hit, manual close…) — sync the DB row. */
async function syncFullClose(
  deps: ReconcilerDeps,
  tc: TradeReduce,
  reason: string,
  commissionShare: number,
): Promise<void> {
  const trade = await deps.prisma.trade.findFirst({
    where: { brokerTradeId: tc.tradeId, status: 'open' },
  });
  if (!trade) return;

  // Accumulate on top of any prior partial-close P&L already synced.
  const realized = Number(trade.realizedPnl ?? 0) + tc.realizedPl + tc.financing - commissionShare;
  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: {
      status: 'closed',
      closedAt: new Date(),
      exitPrice: tc.price ?? undefined,
      realizedPnl: realized,
      swapPnl: Number(trade.swapPnl ?? 0) + tc.financing,
      commission: Number(trade.commission ?? 0) + commissionShare,
    },
  });

  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'reconcile_sync_close',
    entityType: 'trade',
    entityId: trade.id,
    brokerTradeId: tc.tradeId,
    reason,
    realizedPl: tc.realizedPl,
  });

  await publishWsEvent(deps.redis, 'pnl.update', {
    tradeId: trade.id,
    realizedPnl: realized,
    reason,
    source: 'reconciler',
  });

  // BE-115 — trade-close event with reason code and P&L (Telegram when configured).
  await deps.notificationsQueue.add(
    'alert',
    {
      severity: 'info',
      title: 'Trade closed',
      body: `${trade.instrument} ${trade.side}: P&L ${realized.toFixed(2)} (${reason})`,
      event: 'trade.closed',
    },
    { removeOnComplete: 100 },
  );
}

/** Broker partially closed a trade (e.g. BE-051 +1R partial) — accumulate P&L.
 *
 * Units are NOT touched here: the trade manager already reduced them when it
 * initiated the partial; a broker-initiated partial the manager didn't do
 * surfaces via the size_drift mismatch check instead. */
async function syncPartialClose(
  deps: ReconcilerDeps,
  tr: TradeReduce,
  reason: string,
  commissionShare: number,
): Promise<void> {
  const trade = await deps.prisma.trade.findFirst({
    where: { brokerTradeId: tr.tradeId, status: 'open' },
  });
  if (!trade) return;

  const realized = Number(trade.realizedPnl ?? 0) + tr.realizedPl + tr.financing - commissionShare;
  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: {
      realizedPnl: realized,
      swapPnl: Number(trade.swapPnl ?? 0) + tr.financing,
      commission: Number(trade.commission ?? 0) + commissionShare,
    },
  });

  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'reconcile_sync_partial',
    entityType: 'trade',
    entityId: trade.id,
    brokerTradeId: tr.tradeId,
    reason,
    closedUnits: tr.units,
    realizedPl: tr.realizedPl,
  });

  await publishWsEvent(deps.redis, 'pnl.update', {
    tradeId: trade.id,
    realizedPnl: realized,
    partial: true,
    reason,
    source: 'reconciler',
  });
}

interface Mismatch {
  kind: 'unknown_broker_position' | 'size_drift' | 'missing_at_broker';
  instrument: string;
  detail: string;
}

export function detectMismatches(
  brokerPositions: Awaited<ReturnType<QuantExecutionClient['listOpenPositions']>>,
  dbTrades: {
    id: string;
    instrument: string;
    side: string;
    units: unknown;
    brokerTradeId: string | null;
  }[],
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const dbByBrokerId = new Map<string, (typeof dbTrades)[number]>();
  for (const t of dbTrades) {
    if (t.brokerTradeId) dbByBrokerId.set(t.brokerTradeId, t);
  }

  for (const pos of brokerPositions) {
    for (const brokerId of pos.brokerTradeIds) {
      const db = dbByBrokerId.get(brokerId);
      if (!db) {
        mismatches.push({
          kind: 'unknown_broker_position',
          instrument: pos.instrument,
          detail: `broker trade ${brokerId} has no DB row`,
        });
        continue;
      }
      if (Math.abs(Number(db.units) - pos.units) > 0.01) {
        mismatches.push({
          kind: 'size_drift',
          instrument: pos.instrument,
          detail: `trade ${brokerId}: DB ${db.units} vs broker ${pos.units}`,
        });
      }
    }
  }

  const brokerIds = new Set(brokerPositions.flatMap((p) => p.brokerTradeIds));
  for (const t of dbTrades) {
    if (t.brokerTradeId && !brokerIds.has(t.brokerTradeId)) {
      mismatches.push({
        kind: 'missing_at_broker',
        instrument: t.instrument,
        detail: `DB trade ${t.id} (${t.brokerTradeId}) missing at broker`,
      });
    }
  }

  return mismatches;
}

async function handleMismatches(deps: ReconcilerDeps, mismatches: Mismatch[]): Promise<void> {
  const detail = mismatches.map((m) => `${m.kind}: ${m.detail}`).join('; ');

  if (deps.env.RECONCILE_ACTION === 'flatten_and_halt') {
    const positions = await deps.quant.listOpenPositions();
    for (const pos of positions) {
      for (const id of pos.brokerTradeIds) {
        await deps.quant.closeTrade(id);
      }
    }
  }

  await setExecutionHalt(deps.redis, detail);
  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'reconciliation_mismatch',
    entityType: 'system',
    entityId: 'reconciler',
    mismatches,
  });

  await publishWsEvent(deps.redis, 'reconciliation.mismatch', { mismatches, detail });
  await publishWsEvent(deps.redis, 'risk.halt', { reason: detail, source: 'reconciler' });

  await deps.notificationsQueue.add('alert', {
    severity: 'critical',
    title: 'Reconciliation mismatch',
    body: detail,
    event: 'reconciliation.mismatch',
  });
}

export async function processReconciliationJob(_job: Job, deps: ReconcilerDeps): Promise<void> {
  await processReconciliationTick(deps);
}
