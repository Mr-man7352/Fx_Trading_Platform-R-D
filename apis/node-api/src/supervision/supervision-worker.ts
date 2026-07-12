import {
  AGENT_CONTRACT_VERSION,
  type SupervisorInput,
  SupervisorInputSchema,
  type SupervisorOutput,
  validateAgentOutput,
} from '@fx/types';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { isExecutionHalted } from '../execution/halt.js';
import type { KillSwitchStore } from '../execution/kill-switch.js';
import { loadManagerConfig } from '../execution/manager-config.js';
import type { QuantExecutionClient } from '../execution/quant-client.js';
import type { LlmInvoker } from '../signals/agent-graph.js';
import { parseJsonObject } from '../signals/agent-graph.js';
import type { CalendarProvider } from '../signals/risk-gate.js';
import { NO_CALENDAR } from '../signals/risk-gate.js';
import type { SupervisionJob } from '../workers/queues.js';
import { shouldUpdateSl } from '../workers/trade-manager.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';
import {
  DEFAULT_EXIT_CONFIG,
  type ExitConfig,
  type ExitContext,
  evaluateExitLayers,
} from './layered-exits.js';
import {
  DEFAULT_MATERIAL_CHANGE_CONFIG,
  detectMaterialChange,
  type MaterialChangeConfig,
  type SupervisionSnapshot,
  unrealizedR,
} from './material-change.js';

/**
 * BE-080 — supervision worker: gated LLM supervision on OPEN trades.
 *
 * Per tick, per open trade:
 *   1. DETERMINISTIC LAYERED EXITS FIRST (BE-081) — no LLM involved; any
 *      trigger closes via the same gRPC execution channel the kill-switch
 *      close-out uses. First-to-fire wins.
 *   2. Deterministic material-change gate — nothing changed ⇒ HOLD audited as
 *      `supervision_gate_skip` with ZERO LLM cost (story AC; mirrors ADR-010).
 *   3. Material change ⇒ ONE LLM supervisor call with a strict JSON validator
 *      (SupervisorOutputSchema). Advisory + risk-reducing only: CLOSE /
 *      TIGHTEN_STOP (never widen — enforced with shouldUpdateSl) /
 *      TAKE_PARTIAL / HOLD. Schema-invalid output degrades to HOLD.
 *
 * Never runs in backtest mode (QN-056's runner simulates exits in-sim), and
 * never while halted / kill-switched.
 */

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface SupervisionDeps {
  prisma: PrismaClient;
  redis: import('ioredis').Redis;
  quant: QuantExecutionClient;
  /** null ⇒ LLM disabled: layers + gate still run, material changes audited. */
  llm: LlmInvoker | null;
  registry: { get(role: 'supervisor'): { system: string; hash: string } };
  killSwitch: KillSwitchStore | null;
  calendar?: CalendarProvider;
  env: Env;
  /** Injected clock for tests. */
  now?: () => Date;
}

export interface SupervisionOutcome {
  outcome:
    | 'skipped_mode'
    | 'skipped_halt'
    | 'not_open'
    | 'no_price'
    | 'layer_exit'
    | 'gate_skip'
    | 'llm_hold'
    | 'llm_action'
    | 'llm_unavailable'
    | 'schema_invalid';
  layer?: string;
  action?: SupervisorOutput['action'];
  reasons?: string[];
}

interface TradeMeta {
  originalRiskDistance?: number;
  lastTrailSl?: number;
  partialTakenAt?: string;
  supervisionSnapshot?: SupervisionSnapshot;
  exitReason?: string;
  [key: string]: unknown;
}

export function supervisionConfigFromEnv(env: Env): {
  exits: ExitConfig;
  gate: MaterialChangeConfig;
} {
  const exits: ExitConfig = {
    ...DEFAULT_EXIT_CONFIG,
    dailyDrawdownHaltPct: env.RISK_DAILY_DD_HALT_PCT,
    timeStopHours: env.SUPERVISION_TIME_STOP_HOURS,
  };
  const gate: MaterialChangeConfig = {
    ...DEFAULT_MATERIAL_CHANGE_CONFIG,
    adverseR: -Math.abs(env.SUPERVISION_ADVERSE_R),
    timeStopHours: env.SUPERVISION_TIME_STOP_HOURS,
  };
  return { exits, gate };
}

// ─── Context gathering (cheap indexed reads — no gRPC pipeline call) ─────────

async function latestMid(prisma: PrismaClient, instrument: string): Promise<number | null> {
  const tick = await prisma.tick.findFirst({ where: { instrument }, orderBy: { ts: 'desc' } });
  if (!tick) return null;
  return (tick.bid + tick.ask) / 2;
}

async function latestSessionContext(
  prisma: PrismaClient,
  instrument: string,
): Promise<{ sessionLabel: string; liquidityRegime: string; weekendGapWindow: boolean }> {
  const row = await prisma.featureVector.findFirst({
    where: { instrument },
    orderBy: { barTs: 'desc' },
  });
  const features = (row?.features ?? {}) as Record<string, number>;
  return {
    sessionLabel: row?.sessionLabel ?? 'OFF_HOURS',
    liquidityRegime: row?.liquidityRegime ?? 'NORMAL',
    weekendGapWindow: features.weekend_gap_window === 1,
  };
}

async function dailyRealizedPnl(prisma: PrismaClient): Promise<number> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const agg = await prisma.trade.aggregate({
    _sum: { realizedPnl: true },
    where: { status: 'closed', closedAt: { gte: dayStart } },
  });
  return agg._sum.realizedPnl === null ? 0 : Number(agg._sum.realizedPnl);
}

/** Wednesday 17:00-NY rollover within the next 24h while held > 2 days. */
export function tripleSwapAhead(openedAt: Date, now: Date): boolean {
  const heldMs = now.getTime() - openedAt.getTime();
  if (heldMs <= 2 * 86_400_000) return false;
  // NY offset varies with DST; approximating the *ahead* check with UTC day is
  // NOT acceptable per QN-047 — use the NY wall clock via Intl.
  const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = nyNow.getDay();
  const beforeRollover = nyNow.getHours() < 17;
  // Next rollover is Wednesday if it's Wednesday pre-17:00 or Tuesday post-17:00.
  return (day === 3 && beforeRollover) || (day === 2 && !beforeRollover);
}

// ─── The tick ────────────────────────────────────────────────────────────────

export async function processSupervisionJob(
  deps: SupervisionDeps,
  job: SupervisionJob,
): Promise<SupervisionOutcome> {
  const now = deps.now ? deps.now() : new Date();
  if (deps.env.TRADING_MODE === 'backtest') return { outcome: 'skipped_mode' };
  if ((await isExecutionHalted(deps.redis)) || (await deps.killSwitch?.isActive()) === true) {
    return { outcome: 'skipped_halt' };
  }

  const trade = await deps.prisma.trade.findUnique({ where: { id: job.tradeId } });
  if (trade?.status !== 'open') return { outcome: 'not_open' };

  const meta = (trade.meta ?? {}) as TradeMeta;
  const side = trade.side as 'long' | 'short';
  const entry = Number(trade.entryPrice);
  const risk = meta.originalRiskDistance ?? Math.abs(entry - Number(trade.stopLoss ?? entry));

  const current = await latestMid(deps.prisma, trade.instrument);
  if (current === null) return { outcome: 'no_price' };

  const calendar = deps.calendar ?? NO_CALENDAR;
  const { exits, gate } = supervisionConfigFromEnv(deps.env);
  const [session, dailyPnl, account, events] = await Promise.all([
    latestSessionContext(deps.prisma, trade.instrument),
    dailyRealizedPnl(deps.prisma),
    accountEquity(deps),
    calendar.eventsAround(now, exits.newsBlackoutMinutes),
  ]);
  const highImpactEventWithinBlackout = events.length > 0;

  // 1 — BE-081 layered exits (deterministic, LLM-free, first-to-fire).
  const exitCtx: ExitContext = {
    side,
    entryPrice: entry,
    currentPrice: current,
    stopLoss: trade.stopLoss === null ? null : Number(trade.stopLoss),
    takeProfit: trade.takeProfit === null ? null : Number(trade.takeProfit),
    lastTrailSl: meta.lastTrailSl ?? null,
    openedAt: trade.openedAt,
    now,
    equity: account,
    dailyRealizedPnl: dailyPnl,
    calendarAvailable: calendar.available(),
    highImpactEventWithinBlackout,
    config: exits,
  };
  const layered = evaluateExitLayers(exitCtx);
  if (layered.decision) {
    await executeExit(deps, trade.id, layered.decision.layer, layered.decision.scope);
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'supervision_layer_exit',
      entityType: 'trade',
      entityId: trade.id,
      layer: layered.decision.layer,
      scope: layered.decision.scope,
      detail: layered.decision.detail,
      notes: layered.notes,
    });
    return { outcome: 'layer_exit', layer: layered.decision.layer };
  }

  // 2 — BE-080 deterministic gate.
  const snapshot: SupervisionSnapshot = {
    rMultiple: unrealizedR(side, entry, current, risk),
    sessionLabel: session.sessionLabel,
    liquidityRegime: session.liquidityRegime,
    holdingHours: (now.getTime() - trade.openedAt.getTime()) / 3_600_000,
    tripleSwapAhead: tripleSwapAhead(trade.openedAt, now),
    weekendGapWindow: session.weekendGapWindow,
    highImpactEventWithinBlackout,
  };
  const change = detectMaterialChange(meta.supervisionSnapshot ?? null, snapshot, gate);
  if (!change.material) {
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'supervision_gate_skip',
      entityType: 'trade',
      entityId: trade.id,
      llmCost: 0,
      rMultiple: snapshot.rMultiple,
    });
    return { outcome: 'gate_skip' };
  }

  // 3 — LLM supervisor (one call, strict JSON validator).
  if (!deps.llm) {
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'supervision_material_no_llm',
      entityType: 'trade',
      entityId: trade.id,
      reasons: change.reasons,
    });
    return { outcome: 'llm_unavailable', reasons: change.reasons };
  }

  const input: SupervisorInput = {
    contractVersion: AGENT_CONTRACT_VERSION,
    role: 'supervisor',
    trade: {
      tradeId: trade.id,
      instrument: trade.instrument,
      side,
      units: Number(trade.units),
      entryPrice: entry,
      currentPrice: current,
      stopLoss: trade.stopLoss === null ? null : Number(trade.stopLoss),
      takeProfit: trade.takeProfit === null ? null : Number(trade.takeProfit),
      openedAt: trade.openedAt.toISOString(),
      holdingHours: snapshot.holdingHours,
      rMultiple: snapshot.rMultiple,
      partialTaken: Boolean(meta.partialTakenAt),
    },
    market: {
      sessionLabel: snapshot.sessionLabel as SupervisorInput['market']['sessionLabel'],
      liquidityRegime: snapshot.liquidityRegime as SupervisorInput['market']['liquidityRegime'],
      tripleSwapAhead: snapshot.tripleSwapAhead,
      weekendGapWindow: snapshot.weekendGapWindow,
      calendarAvailable: calendar.available(),
      upcomingHighImpactEvent: highImpactEventWithinBlackout,
    },
    changeReasons: change.reasons,
  };
  const inputCheck = SupervisorInputSchema.safeParse(input);
  if (!inputCheck.success) {
    // Contract failure is a code bug — degrade to HOLD, loudly.
    await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
      action: 'supervision_input_invalid',
      entityType: 'trade',
      entityId: trade.id,
      error: inputCheck.error.message,
    });
    return { outcome: 'schema_invalid', reasons: change.reasons };
  }

  const prompt = deps.registry.get('supervisor');
  let decision: SupervisorOutput;
  try {
    const result = await deps.llm.invoke({
      role: 'supervisor',
      system: prompt.system,
      user: JSON.stringify(inputCheck.data),
      promptHash: prompt.hash,
      stageBudgetMs: deps.env.SUPERVISION_STAGE_BUDGET_MS,
    });
    const validated = validateAgentOutput('supervisor', parseJsonObject(result.text));
    if (!validated.ok) {
      await persistSupervision(deps, trade.id, 'hold', `SCHEMA_INVALID: ${validated.error}`, false);
      return { outcome: 'schema_invalid', reasons: change.reasons };
    }
    decision = validated.value;
  } catch (err) {
    await persistSupervision(
      deps,
      trade.id,
      'hold',
      `LLM_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
    return { outcome: 'llm_unavailable', reasons: change.reasons };
  }

  // Persist the snapshot the LLM actually saw — the next gate diffs against it.
  await deps.prisma.trade.update({
    where: { id: trade.id },
    data: { meta: { ...meta, supervisionSnapshot: snapshot } as never },
  });

  const applied = await applyDecision(deps, trade.id, decision, {
    side,
    entry,
    current,
    risk,
    currentSl: trade.stopLoss === null ? null : Number(trade.stopLoss),
    units: Number(trade.units),
    brokerTradeId: trade.brokerTradeId,
    meta,
  });
  await persistSupervision(
    deps,
    trade.id,
    toDbAction(decision.action),
    decision.rationale,
    applied,
  );
  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action: 'supervision_llm_decision',
    entityType: 'trade',
    entityId: trade.id,
    decision: decision.action,
    applied,
    reasons: change.reasons,
  });
  return {
    outcome: decision.action === 'HOLD' ? 'llm_hold' : 'llm_action',
    action: decision.action,
    reasons: change.reasons,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function accountEquity(deps: SupervisionDeps): Promise<number> {
  const closed = await deps.prisma.trade.aggregate({
    _sum: { realizedPnl: true, swapPnl: true, commission: true },
    where: { status: 'closed' },
  });
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  return (
    deps.env.ACCOUNT_BASELINE_EQUITY +
    n(closed._sum.realizedPnl) +
    n(closed._sum.swapPnl) -
    n(closed._sum.commission)
  );
}

function toDbAction(
  action: SupervisorOutput['action'],
): 'hold' | 'close' | 'tighten_stop' | 'take_partial' {
  switch (action) {
    case 'CLOSE':
      return 'close';
    case 'TIGHTEN_STOP':
      return 'tighten_stop';
    case 'TAKE_PARTIAL':
      return 'take_partial';
    default:
      return 'hold';
  }
}

async function persistSupervision(
  deps: SupervisionDeps,
  tradeId: string,
  action: 'hold' | 'close' | 'tighten_stop' | 'take_partial',
  rationale: string,
  applied: boolean,
): Promise<void> {
  await deps.prisma.supervision.create({
    data: { tradeId, action, rationale, applied },
  });
}

/** BE-081/BE-080 shared close path — the reconciler settles final DB state. */
async function executeExit(
  deps: SupervisionDeps,
  tradeId: string,
  reason: string,
  scope: 'close' | 'flatten_all',
): Promise<void> {
  const targets =
    scope === 'flatten_all'
      ? await deps.prisma.trade.findMany({ where: { status: 'open' } })
      : await deps.prisma.trade.findMany({ where: { id: tradeId } });
  for (const t of targets) {
    if (!t.brokerTradeId) continue;
    const result = await deps.quant.closeTrade(t.brokerTradeId);
    const meta = (t.meta ?? {}) as TradeMeta;
    await deps.prisma.trade.update({
      where: { id: t.id },
      data: {
        meta: {
          ...meta,
          exitReason: reason.toUpperCase(),
          exitRequestedAt: new Date().toISOString(),
        } as never,
      },
    });
    if (result.status === 'REJECTED') {
      await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
        action: 'supervision_close_rejected',
        entityType: 'trade',
        entityId: t.id,
        reason,
      });
    }
  }
}

/** Apply an LLM decision — risk-reducing actions only; HOLD is a no-op. */
async function applyDecision(
  deps: SupervisionDeps,
  tradeId: string,
  decision: SupervisorOutput,
  state: {
    side: 'long' | 'short';
    entry: number;
    current: number;
    risk: number;
    currentSl: number | null;
    units: number;
    brokerTradeId: string | null;
    meta: TradeMeta;
  },
): Promise<boolean> {
  if (decision.action === 'HOLD' || !state.brokerTradeId) return false;

  if (decision.action === 'CLOSE') {
    await executeExit(deps, tradeId, 'supervisor_close', 'close');
    return true;
  }

  if (decision.action === 'TAKE_PARTIAL') {
    const config = loadManagerConfig(deps.env);
    const closeUnits = Math.floor(state.units * config.partialFraction);
    if (closeUnits <= 0) return false;
    const result = await deps.quant.closeTrade(state.brokerTradeId, closeUnits);
    if (result.status === 'REJECTED') return false;
    await deps.prisma.trade.update({
      where: { id: tradeId },
      data: {
        units: state.units - closeUnits,
        meta: { ...state.meta, partialTakenAt: new Date().toISOString() } as never,
      },
    });
    return true;
  }

  // TIGHTEN_STOP — deterministic proposal (0.5R behind price), never widened.
  const dist = state.risk * 0.5;
  const proposed = state.side === 'long' ? state.current - dist : state.current + dist;
  const baseline = state.currentSl ?? (state.side === 'long' ? -Infinity : Infinity);
  if (state.currentSl !== null && !shouldUpdateSl(state.side, baseline, proposed)) {
    return false; // would widen or not improve — refuse
  }
  const mod = await deps.quant.modifyTrade(state.brokerTradeId, { stopLossPrice: proposed });
  if (!mod.ok) return false;
  await deps.prisma.trade.update({
    where: { id: tradeId },
    data: { stopLoss: proposed, meta: { ...state.meta, lastTrailSl: proposed } as never },
  });
  return true;
}
