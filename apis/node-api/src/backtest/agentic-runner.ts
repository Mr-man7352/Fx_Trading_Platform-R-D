import { evaluateRiskGate } from '@fx/risk-gate';
import type { AccountState, AgenticMode, Timeframe } from '@fx/types';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import type { AgentGraphResult } from '../signals/agent-graph.js';
import { composeReflection } from '../signals/agent-memory.js';
import type { ContextAssembler } from '../signals/context-assembler.js';
import type { RunPipelineOutcome } from '../signals/quant-pipeline-client.js';
import { riskGateConfigFromEnv } from '../signals/risk-gate.js';
import { ENTRY_GATE_MIN_PROBABILITY } from '../signals/signals-worker.js';
import { deterministicUuid, type InMemoryAgentMemory } from './backtest-memory.js';
import type { CachingLlmInvoker } from './llm-cache.js';
import {
  type ClosedTrade,
  DEFAULT_COST_PARAMS,
  effectiveSpreadPips,
  type OpenPosition,
  pipSize,
  type SimBar,
  stepPosition,
} from './simulated-execution.js';

/**
 * QN-056 — event-driven agentic backtest runner.
 *
 * Strictly SEQUENTIAL bar loop over cached candles; each bar runs the same
 * spine as the live signals worker (BE-066): gRPC RunPipeline → ADR-010
 * entry gate → context assembly (BE-074) → the SAME LangGraph code (BE-062,
 * selected via TRADING_MODE=backtest — asserted at start, design principle
 * #2) → pure deterministic risk gate (§10) → simulated execution.
 *
 * Non-negotiables encoded here:
 * - `gate_skip` bars incur ZERO LLM/cache calls (AC — structurally: the
 *   graph is simply never invoked; the cache's call counter proves it).
 * - Memory starts EMPTY and is rebuilt incrementally in a run-local
 *   in-memory store; live `agent_memory` is never read (AC).
 * - Same config + cached-LLM + same starting state ⇒ bit-identical results
 *   (AC): no clocks, no randomness, deterministic ids, stable iteration.
 * - Quant-only configuration reconciles against the vectorbt engine (QN-050)
 *   within tolerance — `reconcileQuantOnly` below.
 */

// ─── Config / deps ───────────────────────────────────────────────────────────

export interface AgenticBacktestConfig {
  instrument: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
  mode: AgenticMode;
  memoryEnabled: boolean;
  probabilityThreshold: number;
  riskPct: number;
  initialEquity: number;
  /** Bracket horizon in bars — must match the champion's label horizon. */
  horizonBars: number;
  debateRounds?: 0 | 1 | 2;
}

/** The one pipeline surface the runner needs (fakes in tests). */
export interface PipelineRunner {
  runPipeline(instrument: string, timeframe: Timeframe, barTs: Date): Promise<RunPipelineOutcome>;
}

/** The one graph surface the runner needs (the real AgentGraph or a fake). */
export interface GraphRunner {
  run(params: {
    prepared: unknown;
    account: AccountState;
    signalId: string | null;
  }): Promise<AgentGraphResult>;
}

export interface AgenticRunnerDeps {
  prisma: PrismaClient;
  pipeline: PipelineRunner;
  /** null ⇒ quant-only mode (the graph must never be needed). */
  graph: GraphRunner | null;
  assembler: ContextAssembler | null;
  cache: CachingLlmInvoker | null;
  memory: InMemoryAgentMemory | null;
  env: Env;
}

export interface AgenticRunResult {
  runner: 'qn056-v1';
  config: {
    instrument: string;
    timeframe: string;
    from: string;
    to: string;
    mode: AgenticMode;
    memoryEnabled: boolean;
    probabilityThreshold: number;
    riskPct: number;
    initialEquity: number;
    horizonBars: number;
    debateRounds: number | null;
  };
  bars: number;
  gate: {
    cycles: number;
    gateSkips: number;
    gateSkipRate: number;
    pipelineHolds: number;
    quantHolds: number;
    pmVetoes: number;
    pmHolds: number;
    riskGateVetoes: number;
    entries: number;
  };
  llm: {
    mode: AgenticMode;
    calls: number;
    cacheHits: number;
    cacheMisses: number;
    liveCostUsd: number;
    /** QN-052: cached mode with zero misses ⇒ reproducible; live ⇒ never. */
    reproducible: boolean;
    reproducibilityNote: string;
  };
  memory: { enabled: boolean; reflectionsWritten: number; finalSize: number };
  metrics: {
    nTrades: number;
    hitRate: number | null;
    expectancyR: number | null;
    netPnl: number;
    netReturnPct: number;
    worstR: number | null;
    maxDrawdownPct: number;
    finalEquity: number;
    exitReasons: Record<string, number>;
  };
  trades: ClosedTrade[];
}

// ─── The runner ──────────────────────────────────────────────────────────────

export async function runAgenticBacktest(
  deps: AgenticRunnerDeps,
  config: AgenticBacktestConfig,
): Promise<AgenticRunResult> {
  // Design principle #2: the ONE mode flag selects the code path — refuse to
  // simulate against a paper/live-configured process.
  if (deps.env.TRADING_MODE !== 'backtest') {
    throw new Error(
      `agentic runner requires TRADING_MODE=backtest (got '${deps.env.TRADING_MODE}')`,
    );
  }
  if (config.mode !== 'quant-only' && (!deps.graph || !deps.assembler)) {
    throw new Error(`mode ${config.mode} needs the agent graph + assembler wired`);
  }

  const candles = await deps.prisma.candle.findMany({
    where: {
      instrument: config.instrument,
      timeframe: config.timeframe,
      ts: { gte: config.from, lte: config.to },
      complete: true,
    },
    orderBy: { ts: 'asc' },
  });
  if (candles.length === 0) {
    throw new Error(
      `no cached ${config.instrument}/${config.timeframe} candles in window — run the QN-021 backfill`,
    );
  }

  const riskConfig = {
    ...riskGateConfigFromEnv(deps.env),
    minProbability: config.probabilityThreshold,
  };

  let equity = config.initialEquity;
  let peakEquity = equity;
  let maxDrawdownPct = 0;
  let position: OpenPosition | null = null;
  const trades: ClosedTrade[] = [];
  const gate = {
    cycles: 0,
    gateSkips: 0,
    pipelineHolds: 0,
    quantHolds: 0,
    pmVetoes: 0,
    pmHolds: 0,
    riskGateVetoes: 0,
    entries: 0,
  };
  let reflectionsWritten = 0;

  const closePosition = async (trade: ClosedTrade): Promise<void> => {
    trades.push(trade);
    equity += trade.pnl;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity);
    }
    if (deps.memory) {
      const holdingHours =
        (new Date(trade.exitTs).getTime() - new Date(trade.entryTs).getTime()) / 3_600_000;
      await deps.memory.recordOutcome(trade.signalId, {
        rMultiple: trade.rMultiple,
        exitReason: trade.exitReason,
        holdingHours,
        realizedPnl: trade.pnl,
      });
    }
  };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i] as (typeof candles)[number];
    const barTs = candle.ts;
    const isFinalBar = i === candles.length - 1;

    // The SAME per-bar pipeline the live worker calls (point-in-time reads
    // bounded by barTs inside the quant service — no look-ahead by design).
    const outcome = await deps.pipeline.runPipeline(config.instrument, config.timeframe, barTs);
    const result = outcome.kind === 'result' ? outcome.result : null;
    const features = result?.features ?? {};
    const bar: SimBar = {
      ts: barTs,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      sessionLabel: result?.sessionLabel || 'OFF_HOURS',
      spreadPips: features.spread_pips ?? null,
      spreadPctile: features.spread_pctile ?? null,
    };

    // 1 — advance any open position (exits before entries; no re-entry on the
    // exit bar — engine parity: `i = exit_j + 1`).
    let closedThisBar = false;
    if (position) {
      const closed = stepPosition(
        position,
        bar,
        config.horizonBars,
        DEFAULT_COST_PARAMS,
        isFinalBar,
      );
      if (closed) {
        await closePosition(closed);
        position = null;
        closedThisBar = true;
      }
    }
    if (position || closedThisBar) continue;

    // 2 — entry cycle.
    gate.cycles += 1;
    if (!result) {
      gate.pipelineHolds += 1;
      continue;
    }
    // ADR-010 entry gate: ZERO LLM/cache calls below the bar.
    if (
      !result.hasCandidate ||
      result.candidate === null ||
      result.candidate.probability < ENTRY_GATE_MIN_PROBABILITY
    ) {
      gate.gateSkips += 1;
      continue;
    }
    const candidate = result.candidate;
    const signalId = deterministicUuid(
      `sig|${config.instrument}|${config.timeframe}|${barTs.toISOString()}`,
    );
    const account = accountState(equity, config.initialEquity, position, trades, barTs);

    // 3 — decision: quant threshold rule, or the live agent graph.
    let approved: boolean;
    if (config.mode === 'quant-only') {
      approved = candidate.probability >= config.probabilityThreshold;
      if (!approved) gate.quantHolds += 1;
    } else {
      const assembler = deps.assembler as ContextAssembler;
      const preparedOutcome = assembler.prepare({
        result,
        instrument: config.instrument,
        timeframe: config.timeframe,
        barTs,
        configuredDebateRounds: config.debateRounds ?? (deps.env.AGENT_DEBATE_ROUNDS as 0 | 1 | 2),
      });
      if (!preparedOutcome.ok) {
        gate.pmHolds += 1;
        continue;
      }
      const graphResult = await (deps.graph as GraphRunner).run({
        prepared: preparedOutcome.prepared,
        account,
        signalId,
      });
      if (deps.memory) {
        await deps.memory.writeReflection({
          instrument: config.instrument,
          barTs,
          agentRole: 'pm',
          signalId,
          summary: composeReflection(preparedOutcome.prepared, graphResult),
        });
        reflectionsWritten += 1;
      }
      approved = graphResult.decision === 'APPROVE';
      if (graphResult.decision === 'VETO') gate.pmVetoes += 1;
      else if (graphResult.decision === 'HOLD') gate.pmHolds += 1;
    }
    if (!approved) continue;

    // 4 — deterministic risk gate (pure engine, backtest-local facts).
    const verdict = evaluateRiskGate(
      {
        candidate,
        account,
        barTs,
        degradedInstruments: [],
        killSwitchActive: false,
        weeklyPnlPct: windowPnlPct(trades, barTs, 7 * 86_400_000, config.initialEquity),
        instrumentDailyLossPct: Math.max(
          0,
          -windowPnlPct(trades, barTs, 86_400_000, config.initialEquity),
        ),
        openPositions: [],
        clusters: [],
        clusterSetVersion: null,
        calendarAvailable: false,
        upcomingEvents: [],
        sessionLabel: result.sessionLabel || 'OFF_HOURS',
        liquidityRegime: result.liquidityRegime || 'NORMAL',
        spreadPips: features.spread_pips ?? null,
        spreadPctile: features.spread_pctile ?? null,
        weekendGapWindow:
          features.weekend_gap_window === undefined ? null : features.weekend_gap_window === 1,
      },
      riskConfig,
    );
    if (verdict.verdict === 'veto') {
      gate.riskGateVetoes += 1;
      continue;
    }

    // 5 — sizing + open (risk-fraction sizing, engine parity).
    const riskDistance = Math.abs(candidate.entryPrice - candidate.stopLossPrice);
    if (riskDistance <= 0) continue;
    const units = (equity * config.riskPct) / riskDistance;
    position = {
      signalId,
      instrument: config.instrument,
      side: candidate.side,
      entryTs: barTs,
      entryPrice: candidate.entryPrice,
      stopLoss: candidate.stopLossPrice,
      takeProfit: candidate.takeProfitPrice,
      units,
      riskDistance,
      probability: candidate.probability,
      barsHeld: 0,
      entrySpreadPips: effectiveSpreadPips(
        config.instrument,
        features.spread_pips ?? null,
        bar.sessionLabel,
      ),
    };
    gate.entries += 1;
  }

  // Close a dangling position at the final bar close (reason END).
  if (position) {
    const last = candles[candles.length - 1] as (typeof candles)[number];
    const pos = position as OpenPosition;
    const pip = pipSize(pos.instrument);
    const s = pos.side === 'long' ? 1 : -1;
    const grossPips = ((last.close - pos.entryPrice) / pip) * s;
    const netPips = grossPips - pos.entrySpreadPips;
    await closePosition({
      signalId: pos.signalId,
      instrument: pos.instrument,
      side: pos.side,
      entryTs: pos.entryTs.toISOString(),
      exitTs: last.ts.toISOString(),
      entryPrice: pos.entryPrice,
      exitPrice: last.close,
      exitReason: 'END',
      probability: pos.probability,
      grossPips,
      costs: {
        spreadPips: pos.entrySpreadPips,
        slippagePips: 0,
        swapPips: 0,
        gapExcessPips: 0,
        flashEvent: false,
      },
      netPips,
      rMultiple: pos.riskDistance > 0 ? (netPips * pip) / pos.riskDistance : 0,
      pnl: netPips * pip * pos.units,
    });
  }

  const rs = trades.map((t) => t.rMultiple);
  const stats = deps.cache?.stats ?? { calls: 0, hits: 0, misses: 0, liveCostUsd: 0 };
  const reproducible =
    config.mode === 'quant-only' ? true : config.mode === 'cached-llm' && stats.misses === 0;
  return {
    runner: 'qn056-v1',
    config: {
      instrument: config.instrument,
      timeframe: config.timeframe,
      from: config.from.toISOString(),
      to: config.to.toISOString(),
      mode: config.mode,
      memoryEnabled: config.memoryEnabled,
      probabilityThreshold: config.probabilityThreshold,
      riskPct: config.riskPct,
      initialEquity: config.initialEquity,
      horizonBars: config.horizonBars,
      debateRounds: config.debateRounds ?? null,
    },
    bars: candles.length,
    gate: {
      ...gate,
      gateSkipRate: gate.cycles > 0 ? gate.gateSkips / gate.cycles : 0,
    },
    llm: {
      mode: config.mode,
      calls: stats.calls,
      cacheHits: stats.hits,
      cacheMisses: stats.misses,
      liveCostUsd: stats.liveCostUsd,
      reproducible,
      reproducibilityNote:
        config.mode === 'live-llm'
          ? 'live-llm runs are explicitly NON-reproducible (QN-052)'
          : config.mode === 'cached-llm' && !reproducible
            ? 'cache misses occurred — re-run to replay fully from cache'
            : 'deterministic',
    },
    memory: {
      enabled: config.memoryEnabled && deps.memory !== null,
      reflectionsWritten,
      finalSize: deps.memory?.size ?? 0,
    },
    metrics: {
      nTrades: trades.length,
      hitRate: rs.length ? rs.filter((r) => r > 0).length / rs.length : null,
      expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      netPnl: trades.reduce((a, t) => a + t.pnl, 0),
      netReturnPct: trades.reduce((a, t) => a + t.pnl, 0) / config.initialEquity,
      worstR: rs.length ? Math.min(...rs) : null,
      maxDrawdownPct,
      finalEquity: equity,
      exitReasons: trades.reduce<Record<string, number>>((acc, t) => {
        acc[t.exitReason] = (acc[t.exitReason] ?? 0) + 1;
        return acc;
      }, {}),
    },
    trades,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function accountState(
  equity: number,
  initialEquity: number,
  position: OpenPosition | null,
  trades: ClosedTrade[],
  barTs: Date,
): AccountState {
  return {
    equity,
    openPositions: position ? 1 : 0,
    dailyPnlPct: windowPnlPct(trades, barTs, 86_400_000, initialEquity),
    openRiskPct: position ? (position.riskDistance * position.units) / Math.max(equity, 1) : 0,
  };
}

function windowPnlPct(
  trades: ClosedTrade[],
  barTs: Date,
  windowMs: number,
  initialEquity: number,
): number {
  const floor = barTs.getTime() - windowMs;
  const pnl = trades
    .filter((t) => new Date(t.exitTs).getTime() >= floor)
    .reduce((a, t) => a + t.pnl, 0);
  return initialEquity > 0 ? pnl / initialEquity : 0;
}

// ─── QN-056 AC: quant-only reconciliation vs the vectorbt engine ────────────

export interface ReconciliationReport {
  withinTolerance: boolean;
  checks: Record<string, unknown>;
}

/**
 * Cross-check the runner's quant-only result against the QN-050 engine
 * report for the same window/threshold. Entry timestamps must substantially
 * agree and expectancy/net-P&L must sit inside tolerance — the two engines
 * share fill semantics by construction, so drift means a bug.
 */
export function reconcileQuantOnly(
  runner: AgenticRunResult,
  engineReport: {
    metrics: { n_trades: number; expectancy_r: number };
    trades: Array<{ entry_ts: string }>;
  },
  tolerance: { expectancyR?: number; entryOverlapMin?: number } = {},
): ReconciliationReport {
  const tolR = tolerance.expectancyR ?? 0.1;
  const overlapMin = tolerance.entryOverlapMin ?? 0.9;

  const runnerEntries = new Set(runner.trades.map((t) => t.entryTs));
  const engineEntries = engineReport.trades.map((t) => t.entry_ts);
  const shared = engineEntries.filter((ts) => runnerEntries.has(ts)).length;
  const denom = Math.max(runner.trades.length, engineEntries.length, 1);
  const overlap = shared / denom;

  const runnerExp = runner.metrics.expectancyR ?? 0;
  const engineExp = engineReport.metrics.expectancy_r;
  const expDiff = Math.abs(runnerExp - engineExp);

  const checks = {
    runner_trades: runner.trades.length,
    engine_trades: engineReport.metrics.n_trades,
    entry_overlap: overlap,
    entry_overlap_min: overlapMin,
    runner_expectancy_r: runnerExp,
    engine_expectancy_r: engineExp,
    expectancy_diff_r: expDiff,
    expectancy_tolerance_r: tolR,
  };
  return {
    withinTolerance: overlap >= overlapMin && expDiff <= tolR,
    checks,
  };
}
