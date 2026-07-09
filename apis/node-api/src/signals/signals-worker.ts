import type { HoldReason, Timeframe } from '@fx/types';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { isExecutionHalted } from '../execution/halt.js';
import type { ExecutionJob, NotificationJob, SignalJob } from '../workers/queues.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';
import { publishWsEvent } from '../workers/ws-publish.js';
import type { AccountStateProvider } from './account-state.js';
import type { AgentGraph, AgentGraphResult } from './agent-graph.js';
import type { AgentMemoryStore } from './agent-memory.js';
import { composeReflection } from './agent-memory.js';
import type { ContextAssembler, PreparedContext } from './context-assembler.js';
import { type DisagreementWriter, logDisagreement } from './disagreement.js';
import type { QuantPipelineClient } from './quant-pipeline-client.js';
import { evaluateWithTimeout, type RiskGate } from './risk-gate.js';

/**
 * BE-066 — signals worker: the full entry cycle on bar close.
 *
 *   bar-close job → gRPC RunPipeline → DETERMINISTIC ENTRY GATE (ADR-010)
 *   → semaphore (cap 3, liquidity priority; E2E CLOCK STARTS AT ACQUISITION)
 *   → context assembly (BE-074) → agent graph (BE-062) → risk gate seam
 *   → SizePosition → TradeIntent + execution queue on APPROVE.
 *
 * Non-negotiables encoded here:
 * - No candidate, or candidate P < 0.50 pre-filter ⇒ HOLD `gate_skip` with
 *   ZERO LLM cost — the graph never fires (ADR-010).
 * - Every failure path completes the BullMQ job (HOLD + audit) — no
 *   unhandled throw, no silent retry loop (ADR-009).
 * - Queued instruments' E2E clocks start at semaphore acquisition, so a
 *   3-instrument bar close can't starve #4 into a systematic HOLD (§2.2).
 * - Budget overrun anywhere ⇒ HOLD + partial transcript persisted.
 * - Agent APPROVE alone never executes: the risk-gate seam (fail-safe VETO
 *   until BE-070) is the final deterministic authority (§10).
 */

// ─── Entry gate (ADR-010) ────────────────────────────────────────────────────

/** Pre-filter: below this the graph is never invoked. NOT the ADR-008 0.60 —
 * the gate is deliberately looser so the veto cohort (BE-065) sees the
 * 0.50–0.60 band where agent judgement is most informative. */
export const ENTRY_GATE_MIN_PROBABILITY = 0.5;

// ─── Liquidity priority (§9.6: queued by instrument liquidity) ───────────────

const LIQUIDITY_RANK: Record<string, number> = {
  EUR_USD: 1,
  USD_JPY: 2,
  GBP_USD: 3,
  AUD_USD: 4,
  USD_CHF: 5,
  USD_CAD: 6,
  XAU_USD: 7,
  NZD_USD: 8,
};

export function liquidityPriority(instrument: string): number {
  return LIQUIDITY_RANK[instrument] ?? 100;
}

// ─── Priority semaphore ──────────────────────────────────────────────────────

export class PrioritySemaphore {
  private available: number;
  private readonly waiting: Array<{ priority: number; seq: number; resolve: () => void }> = [];
  private seq = 0;

  constructor(permits: number) {
    this.available = permits;
  }

  /** Lower priority number = more liquid = served first (FIFO within ties). */
  async acquire(priority: number): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push({ priority, seq: this.seq, resolve });
      this.seq += 1;
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.available += 1;
  }
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface SignalsWorkerDeps {
  prisma: PrismaClient;
  redis: Redis;
  pipeline: QuantPipelineClient;
  assembler: ContextAssembler;
  graph: AgentGraph;
  riskGate: RiskGate;
  account: AccountStateProvider;
  /** null ⇒ memory disabled (ablation) — reflections are not written. */
  memory: AgentMemoryStore | null;
  executionQueue: Queue<ExecutionJob>;
  notificationsQueue: Queue<NotificationJob>;
  semaphore: PrioritySemaphore;
  env: Env;
}

// ─── Cycle outcome (returned for tests; every path completes the job) ────────

export interface CycleOutcome {
  outcome:
    | 'hold'
    | 'gate_skip'
    | 'pm_veto'
    | 'pm_hold'
    | 'risk_gate_veto'
    | 'zero_units'
    | 'executed';
  reason?: HoldReason | string;
  signalId?: string;
}

async function audit(
  deps: SignalsWorkerDeps,
  action: string,
  entityId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeWorkerAudit(deps.prisma, deps.env.TRADING_MODE, {
    action,
    entityType: 'signal_cycle',
    entityId,
    ...extra,
  });
}

async function emit(deps: SignalsWorkerDeps, event: string, payload: unknown): Promise<void> {
  await publishWsEvent(deps.redis, 'signals', { event, payload });
}

/** Persist transcript turns + degradation notes to agent_debates (partial-safe). */
async function persistDebate(
  deps: SignalsWorkerDeps,
  signalId: string,
  result: AgentGraphResult,
): Promise<void> {
  let seq = 0;
  const rows = [
    ...result.transcript.map((t) => ({
      signalId,
      round: t.round,
      seq: seq++,
      speaker: t.speaker,
      content: JSON.stringify({ argument: t.argument, confidence: t.confidence }),
    })),
    // Degradation/skip/override notes recorded as 'judge' utterances.
    ...result.notes.map((note) => ({
      signalId,
      round: -1,
      seq: seq++,
      speaker: 'judge' as const,
      content: note,
    })),
  ];
  if (rows.length > 0) {
    await deps.prisma.agentDebateMessage.createMany({ data: rows });
  }
}

async function writeReflectionSafe(
  deps: SignalsWorkerDeps,
  prepared: PreparedContext,
  result: AgentGraphResult,
  signalId: string,
): Promise<void> {
  if (!deps.memory) return;
  try {
    await deps.memory.writeReflection({
      instrument: prepared.pipeline.instrument,
      barTs: new Date(prepared.pipeline.barTs),
      agentRole: 'pm',
      signalId,
      summary: composeReflection(prepared, result),
    });
  } catch (err) {
    // Memory is an enhancement — its failure never fails the cycle.
    console.warn(`[signals] reflection write failed for ${signalId}:`, err);
  }
}

// ─── The cycle ───────────────────────────────────────────────────────────────

export async function processSignalJob(
  deps: SignalsWorkerDeps,
  job: SignalJob,
): Promise<CycleOutcome> {
  const { instrument } = job;
  const timeframe = job.timeframe as Timeframe;
  const barTs = new Date(job.barTs);
  const cycleId = `${instrument}-${timeframe}-${barTs.getTime()}`;

  // Kill-switch/halt: no LLM spend while flat-and-halted.
  if (await isExecutionHalted(deps.redis)) {
    await audit(deps, 'signal_cycle_skipped_halt', cycleId);
    return { outcome: 'hold', reason: 'halted' };
  }

  // 1 — deterministic quant pipeline (breaker-wrapped; never throws).
  const pipelineOutcome = await deps.pipeline.runPipeline(instrument, timeframe, barTs);
  if (pipelineOutcome.kind === 'hold') {
    await audit(deps, 'signal_cycle_hold', cycleId, {
      reason: pipelineOutcome.reason,
      detail: pipelineOutcome.detail,
    });
    await emit(deps, 'signal:hold', {
      instrument,
      barTs: job.barTs,
      reason: pipelineOutcome.reason,
    });
    return { outcome: 'hold', reason: pipelineOutcome.reason };
  }
  const result = pipelineOutcome.result;

  // 2 — ADR-010 entry gate: zero LLM cost below the bar.
  if (
    !result.hasCandidate ||
    result.candidate === null ||
    result.candidate.probability < ENTRY_GATE_MIN_PROBABILITY
  ) {
    await audit(deps, 'signal_cycle_gate_skip', cycleId, {
      hasCandidate: result.hasCandidate,
      probability: result.candidate?.probability ?? null,
      llmCost: 0,
    });
    return { outcome: 'gate_skip', reason: 'GATE_SKIP' };
  }
  const candidate = result.candidate;

  // 3 — persist the Signal row (audit spine for runs/debate/intents).
  const signal = await deps.prisma.signal.create({
    data: {
      barTs,
      instrument,
      timeframe,
      side: candidate.side,
      entryPrice: candidate.entryPrice,
      stopLoss: candidate.stopLossPrice,
      takeProfit: candidate.takeProfitPrice,
      quantScore: candidate.probability,
      metaProbability: result.challengerProbability,
      status: 'candidate',
      tradingMode: deps.env.TRADING_MODE,
      features: result.features,
    },
  });

  // 4 — concurrency cap (3). E2E clock starts at ACQUISITION (§2.2).
  await deps.semaphore.acquire(liquidityPriority(instrument));
  const e2eStart = Date.now();
  const e2eBudget = deps.env.SIGNALS_E2E_BUDGET_MS;
  const overBudget = () => Date.now() - e2eStart > e2eBudget;

  try {
    // 5 — validated context (fails fast, pre-LLM).
    const preparedOutcome = deps.assembler.prepare({
      result,
      instrument,
      timeframe,
      barTs,
      configuredDebateRounds: deps.env.AGENT_DEBATE_ROUNDS as 0 | 1 | 2,
    });
    if (!preparedOutcome.ok) {
      await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'rejected' } });
      await audit(deps, 'signal_cycle_hold', signal.id, {
        reason: preparedOutcome.reason,
        detail: preparedOutcome.detail,
      });
      return { outcome: 'hold', reason: preparedOutcome.reason, signalId: signal.id };
    }
    const prepared = preparedOutcome.prepared;
    const account = await deps.account.current();

    // 6 — the agent graph (own 120s budget; returns partial transcript on overrun).
    const graphResult = await deps.graph.run({
      prepared,
      account,
      signalId: signal.id,
    });
    await persistDebate(deps, signal.id, graphResult);
    await emit(deps, 'signal:debate', {
      signalId: signal.id,
      instrument,
      decision: graphResult.decision,
      holdReason: graphResult.holdReason,
      transcriptLength: graphResult.transcript.length,
      costUsd: graphResult.costUsd,
    });

    // 7 — BE-065 disagreement cohort (before any early return).
    await logDisagreement(deps.prisma as unknown as DisagreementWriter, {
      signalId: signal.id,
      quantProbability: candidate.probability,
      probabilityThreshold: deps.env.RISK_PROBABILITY_THRESHOLD,
      result: graphResult,
    });
    await writeReflectionSafe(deps, prepared, graphResult, signal.id);

    if (graphResult.decision !== 'APPROVE') {
      await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'rejected' } });
      const outcome = graphResult.decision === 'VETO' ? 'pm_veto' : 'pm_hold';
      await audit(deps, `signal_cycle_${outcome}`, signal.id, {
        holdReason: graphResult.holdReason,
        holdDetail: graphResult.holdDetail,
        costUsd: graphResult.costUsd,
      });
      return { outcome, reason: graphResult.holdReason ?? 'pm_decision', signalId: signal.id };
    }

    // 8 — E2E budget check before spending on gate + sizing.
    if (overBudget()) {
      await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'expired' } });
      await audit(deps, 'signal_cycle_hold', signal.id, {
        reason: 'BUDGET_EXCEEDED',
        detail: `E2E ${Date.now() - e2eStart}ms > ${e2eBudget}ms (from semaphore acquisition)`,
      });
      return { outcome: 'hold', reason: 'BUDGET_EXCEEDED', signalId: signal.id };
    }

    // 9 — deterministic risk gate (final authority; fail-safe VETO).
    const degraded = await degradedInstruments(deps.redis);
    const verdict = await evaluateWithTimeout(deps.riskGate, {
      candidate,
      account,
      degradedInstruments: degraded,
      barTs,
    });
    if (verdict.verdict === 'veto') {
      await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'rejected' } });
      await audit(deps, 'signal_cycle_risk_gate_veto', signal.id, {
        reasonCode: verdict.reasonCode,
        checks: verdict.checks,
      });
      await emit(deps, 'signal:risk_gate_veto', {
        signalId: signal.id,
        reasonCode: verdict.reasonCode,
      });
      return {
        outcome: 'risk_gate_veto',
        reason: verdict.reasonCode ?? 'veto',
        signalId: signal.id,
      };
    }

    // 10 — deterministic sizing (QN-042). Zero units ⇒ no trade.
    const sizing = await deps.pipeline.sizePosition({
      instrument,
      side: candidate.side,
      probability: candidate.probability,
      accountEquity: account.equity,
      entryPrice: candidate.entryPrice,
      stopLossPrice: candidate.stopLossPrice,
    });
    if (sizing.kind === 'hold' || sizing.sizing.units <= 0 || overBudget()) {
      await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'rejected' } });
      const reason =
        sizing.kind === 'hold' ? sizing.reason : overBudget() ? 'BUDGET_EXCEEDED' : 'zero_units';
      await audit(deps, 'signal_cycle_no_size', signal.id, { reason });
      return { outcome: 'zero_units', reason, signalId: signal.id };
    }

    // 11 — TradeIntent + execution queue.
    const intent = await deps.prisma.tradeIntent.create({
      data: {
        signalId: signal.id,
        instrument,
        side: candidate.side,
        units: sizing.sizing.units,
        entryPrice: candidate.entryPrice,
        stopLoss: candidate.stopLossPrice,
        takeProfit: candidate.takeProfitPrice,
        riskPct: account.equity > 0 ? sizing.sizing.riskAmount / account.equity : 0,
        riskGate: {
          verdict: 'approved',
          checks: verdict.checks,
          sizing: {
            model: sizing.sizing.sizingModelVersion,
            targetVolatility: sizing.sizing.targetVolatility,
            capsApplied: sizing.sizing.capsApplied,
            probScale: sizing.sizing.probScale,
          },
        } as never,
        status: 'approved',
        tradingMode: deps.env.TRADING_MODE,
      },
    });
    await deps.prisma.signal.update({ where: { id: signal.id }, data: { status: 'approved' } });
    await deps.executionQueue.add(
      'execute-intent',
      { intentId: intent.id },
      { jobId: `intent-${intent.id}`, removeOnComplete: 1000 },
    );
    await audit(deps, 'signal_cycle_executed', signal.id, {
      intentId: intent.id,
      units: sizing.sizing.units,
      e2eMs: Date.now() - e2eStart,
      costUsd: graphResult.costUsd,
    });
    await emit(deps, 'signal:approved', {
      signalId: signal.id,
      intentId: intent.id,
      instrument,
      side: candidate.side,
      units: sizing.sizing.units,
    });
    return { outcome: 'executed', signalId: signal.id };
  } finally {
    deps.semaphore.release();
  }
}

/** BE-044 flags from Redis (same channel the data-quality monitor writes). */
async function degradedInstruments(redis: Redis): Promise<string[]> {
  try {
    const flags = await redis.smembers('data-quality:degraded');
    return flags ?? [];
  } catch {
    return []; // gate itself blocks on its own inputs; absence ≠ approval
  }
}

// ─── Trade-close outcome sweep (BE-064 phase-2 write) ────────────────────────

/**
 * Attach realized outcomes to reflections for trades closed since `since`.
 * Runs on a timer in the worker; idempotent (jsonb overwrite with the same
 * values). R-multiple = realized P&L / risk at the stop from the intent.
 */
export async function sweepTradeOutcomes(
  prisma: PrismaClient,
  memory: AgentMemoryStore,
  since: Date,
): Promise<number> {
  const closed = await prisma.trade.findMany({
    where: { status: 'closed', closedAt: { gte: since }, intentId: { not: null } },
    include: {
      intent: { select: { signalId: true, entryPrice: true, stopLoss: true, units: true } },
    },
  });
  let updated = 0;
  for (const trade of closed) {
    const intent = trade.intent;
    if (!intent) continue;
    const entry = Number(intent.entryPrice ?? trade.entryPrice);
    const stop = Number(intent.stopLoss);
    const riskAmount = Math.abs(entry - stop) * Number(intent.units);
    const realized = Number(trade.realizedPnl ?? 0);
    const holdingHours =
      trade.closedAt !== null
        ? (trade.closedAt.getTime() - trade.openedAt.getTime()) / 3_600_000
        : null;
    await memory.recordOutcome(intent.signalId, {
      rMultiple: riskAmount > 0 ? realized / riskAmount : null,
      exitReason: (trade.meta as { exitReason?: string } | null)?.exitReason ?? 'CLOSED',
      holdingHours,
      realizedPnl: realized,
    });
    updated += 1;
  }
  return updated;
}
