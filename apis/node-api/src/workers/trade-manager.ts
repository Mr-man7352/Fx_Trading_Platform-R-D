import type { Job } from 'bullmq';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { isExecutionHalted } from '../execution/halt.js';
import { loadManagerConfig, type ManagerConfig } from '../execution/manager-config.js';
import type { QuantExecutionClient } from '../execution/quant-client.js';
import { writeWorkerAudit } from './worker-audit.js';

/** BE-051 — trailing stop, partial close, breakeven manager (30s tick). */

export interface TradeManagerDeps {
  prisma: PrismaClient;
  redis: import('ioredis').Redis;
  quant: QuantExecutionClient;
  env: Env;
}

interface TradeMeta {
  originalRiskDistance?: number;
  originalStopLoss?: number;
  partialTakenAt?: string;
  breakevenSetAt?: string;
  trailActive?: boolean;
  lastTrailSl?: number;
}

async function latestMid(prisma: PrismaClient, instrument: string): Promise<number | null> {
  const tick = await prisma.tick.findFirst({
    where: { instrument },
    orderBy: { ts: 'desc' },
  });
  if (!tick) return null;
  return (tick.bid + tick.ask) / 2;
}

function rMultiple(side: 'long' | 'short', entry: number, current: number, risk: number): number {
  if (risk <= 0) return 0;
  const move = side === 'long' ? current - entry : entry - current;
  return move / risk;
}

function breakevenSl(side: 'long' | 'short', entry: number, risk: number, bufferR: number): number {
  const buffer = risk * bufferR;
  return side === 'long' ? entry + buffer : entry - buffer;
}

function trailSl(side: 'long' | 'short', current: number, risk: number, trailR: number): number {
  const dist = risk * trailR;
  return side === 'long' ? current - dist : current + dist;
}

/** Never widen SL — long SL only moves up, short only moves down. */
export function shouldUpdateSl(
  side: 'long' | 'short',
  currentSl: number,
  proposedSl: number,
): boolean {
  if (side === 'long') return proposedSl > currentSl;
  return proposedSl < currentSl;
}

export async function processTradeManagerTick(deps: TradeManagerDeps): Promise<void> {
  if (deps.env.TRADING_MODE === 'backtest') return;
  if (await isExecutionHalted(deps.redis)) return;

  const config = loadManagerConfig(deps.env);
  const trades = await deps.prisma.trade.findMany({ where: { status: 'open' } });

  for (const trade of trades) {
    const meta = (trade.meta ?? {}) as TradeMeta;
    const risk = meta.originalRiskDistance ?? 0;
    if (risk <= 0) continue;

    const current = await latestMid(deps.prisma, trade.instrument);
    if (current === null) continue;

    const entry = Number(trade.entryPrice);
    const side = trade.side as 'long' | 'short';
    const r = rMultiple(side, entry, current, risk);
    const sl = Number(trade.stopLoss ?? meta.originalStopLoss ?? 0);

    if (r >= config.partialTriggerR && !meta.partialTakenAt) {
      await takePartial(deps, trade, config, meta, side);
      continue;
    }

    // Breakeven modify rejected earlier → retry until it sticks (the partial
    // itself is never repeated — partialTakenAt gates that).
    if (meta.partialTakenAt && !meta.breakevenSetAt) {
      await retryBreakeven(deps, trade, config, meta, side);
      continue;
    }

    if (meta.breakevenSetAt) {
      await maybeTrail(deps, trade, config, meta, side, current, sl);
    }
  }
}

/** Re-attempt the breakeven SL move if the modify was rejected at +1R time. */
async function retryBreakeven(
  deps: TradeManagerDeps,
  trade: Awaited<ReturnType<PrismaClient['trade']['findMany']>>[number],
  config: ManagerConfig,
  meta: TradeMeta,
  side: 'long' | 'short',
): Promise<void> {
  if (!trade.brokerTradeId) return;
  const risk = meta.originalRiskDistance ?? 0;
  if (risk <= 0) return;
  const newSl = breakevenSl(side, Number(trade.entryPrice), risk, config.breakevenBufferR);
  const mod = await deps.quant.modifyTrade(trade.brokerTradeId, { stopLossPrice: newSl });
  if (!mod.ok) return; // try again next tick

  const now = new Date().toISOString();
  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: {
      stopLoss: newSl,
      meta: { ...meta, breakevenSetAt: now, trailActive: true, lastTrailSl: newSl } as never,
    },
  });
  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'breakeven_sl',
    entityType: 'trade',
    entityId: trade.id,
    stopLoss: newSl,
    retried: true,
  });
}

async function takePartial(
  deps: TradeManagerDeps,
  trade: Awaited<ReturnType<PrismaClient['trade']['findMany']>>[number],
  config: ManagerConfig,
  meta: TradeMeta,
  side: 'long' | 'short',
): Promise<void> {
  if (!trade.brokerTradeId) return;
  const closeUnits = Math.floor(Number(trade.units) * config.partialFraction);
  if (closeUnits <= 0) return;

  const closeResult = await deps.quant.closeTrade(trade.brokerTradeId, closeUnits);
  if (closeResult.status === 'REJECTED') return;

  const remaining = Number(trade.units) - closeUnits;
  const entry = Number(trade.entryPrice);
  const risk = meta.originalRiskDistance ?? 0;
  const newSl = breakevenSl(side, entry, risk, config.breakevenBufferR);

  const mod = await deps.quant.modifyTrade(trade.brokerTradeId, { stopLossPrice: newSl });
  const now = new Date().toISOString();
  const updatedMeta: TradeMeta = {
    ...meta,
    partialTakenAt: now,
    breakevenSetAt: mod.ok ? now : meta.breakevenSetAt,
    trailActive: mod.ok,
    lastTrailSl: mod.ok ? newSl : meta.lastTrailSl,
  };

  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: {
      units: remaining,
      stopLoss: mod.ok ? newSl : trade.stopLoss,
      meta: updatedMeta as never,
    },
  });

  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'partial_close',
    entityType: 'trade',
    entityId: trade.id,
    closeUnits,
    breakevenSl: newSl,
  });
}

async function maybeTrail(
  deps: TradeManagerDeps,
  trade: Awaited<ReturnType<PrismaClient['trade']['findMany']>>[number],
  config: ManagerConfig,
  meta: TradeMeta,
  side: 'long' | 'short',
  current: number,
  sl: number,
): Promise<void> {
  if (!trade.brokerTradeId) return;
  const risk = meta.originalRiskDistance ?? 0;
  const proposed = trailSl(side, current, risk, config.trailDistanceR);
  if (!shouldUpdateSl(side, sl, proposed)) return;

  const mod = await deps.quant.modifyTrade(trade.brokerTradeId, { stopLossPrice: proposed });
  if (!mod.ok) return;

  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: {
      stopLoss: proposed,
      meta: { ...meta, lastTrailSl: proposed } as never,
    },
  });

  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'trail_sl',
    entityType: 'trade',
    entityId: trade.id,
    stopLoss: proposed,
  });
}

export async function processTradeManagerJob(_job: Job, deps: TradeManagerDeps): Promise<void> {
  await processTradeManagerTick(deps);
}
