import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import {
  processSupervisionJob,
  type SupervisionDeps,
  supervisionConfigFromEnv,
  tripleSwapAhead,
} from './supervision-worker.js';

/**
 * BE-080 — worker-level ACs with injected fakes:
 *   - nothing changed ⇒ gate_skip, ZERO LLM calls, llmCost:0 audited
 *   - material change ⇒ ONE LLM call, strict JSON validation
 *   - schema-invalid LLM output ⇒ degraded HOLD supervision row, applied=false
 *   - layered exit fires BEFORE any LLM involvement
 */

const BASE_ENV = {
  TRADING_MODE: 'paper',
  RISK_DAILY_DD_HALT_PCT: 0.05,
  SUPERVISION_TIME_STOP_HOURS: 72,
  SUPERVISION_ADVERSE_R: 0.75,
  SUPERVISION_STAGE_BUDGET_MS: 15_000,
  SUPERVISION_INTERVAL_MS: 60_000,
  ACCOUNT_BASELINE_EQUITY: 10_000,
  TRADE_MANAGER_PARTIAL_TRIGGER_R: 1,
  TRADE_MANAGER_PARTIAL_FRACTION: 0.5,
  TRADE_MANAGER_BREAKEVEN_BUFFER_R: 0.05,
  TRADE_MANAGER_TRAIL_DISTANCE_R: 0.5,
} as unknown as Env;

interface FakeState {
  trade: Record<string, unknown>;
  audits: Array<Record<string, unknown>>;
  supervisions: Array<Record<string, unknown>>;
  tradeUpdates: Array<Record<string, unknown>>;
  closedTrades: Array<{ id: string; units?: number }>;
  modifies: Array<Record<string, unknown>>;
  llmCalls: number;
  llmResponse: string;
}

function makeState(tradeOverrides: Record<string, unknown> = {}): FakeState {
  return {
    trade: {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'open',
      instrument: 'EUR_USD',
      side: 'long',
      units: 1000,
      entryPrice: 1.1,
      stopLoss: 1.09,
      takeProfit: 1.118,
      openedAt: new Date('2026-07-06T10:00:00Z'),
      brokerTradeId: 'b-1',
      meta: { originalRiskDistance: 0.01 },
      ...tradeOverrides,
    },
    audits: [],
    supervisions: [],
    tradeUpdates: [],
    closedTrades: [],
    modifies: [],
    llmCalls: 0,
    llmResponse: JSON.stringify({ action: 'HOLD', confidence: 0.6, rationale: 'thesis intact' }),
  };
}

function makeDeps(state: FakeState, overrides: Partial<SupervisionDeps> = {}): SupervisionDeps {
  const prisma = {
    trade: {
      findUnique: async () => state.trade,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        where.id ? [state.trade] : [state.trade],
      aggregate: async () => ({ _sum: { realizedPnl: 0, swapPnl: 0, commission: 0 } }),
      update: async (args: Record<string, unknown>) => {
        state.tradeUpdates.push(args);
        const data = (args as { data: Record<string, unknown> }).data;
        state.trade = { ...state.trade, ...data };
        return state.trade;
      },
    },
    tick: {
      findFirst: async () => ({ bid: 1.1049, ask: 1.1051, ts: new Date() }),
    },
    featureVector: {
      findFirst: async () => ({
        sessionLabel: 'LONDON',
        liquidityRegime: 'NORMAL',
        features: { weekend_gap_window: 0 },
      }),
    },
    supervision: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.supervisions.push(args.data);
        return args.data;
      },
    },
    auditLog: {
      create: async (args: { data: { details: Record<string, unknown> } }) => {
        state.audits.push(args.data.details);
        return args.data;
      },
    },
  };
  const quant = {
    closeTrade: async (id: string, units?: number) => {
      state.closedTrades.push({ id, units });
      return { status: 'CLOSED', ok: true };
    },
    modifyTrade: async (id: string, params: Record<string, unknown>) => {
      state.modifies.push({ id, ...params });
      return { ok: true };
    },
  };
  const llm = {
    invoke: async () => {
      state.llmCalls += 1;
      return {
        text: state.llmResponse,
        provider: 'anthropic',
        model: 'test',
        tier: 'standard',
        modelDowngraded: false,
        downgradeReason: null,
        failedOver: false,
        latencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
      };
    },
  };
  return {
    prisma: prisma as never,
    redis: { get: async () => null } as never,
    quant: quant as never,
    llm: llm as never,
    registry: { get: () => ({ system: 'supervisor prompt', hash: 'h1' }) },
    killSwitch: { isActive: async () => false } as never,
    env: BASE_ENV,
    now: () => new Date('2026-07-06T14:00:00Z'),
    ...overrides,
  };
}

describe('processSupervisionJob (BE-080)', () => {
  it('skips entirely in backtest mode', async () => {
    const state = makeState();
    const deps = makeDeps(state, { env: { ...BASE_ENV, TRADING_MODE: 'backtest' } as Env });
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('skipped_mode');
    expect(state.llmCalls).toBe(0);
  });

  it('nothing changed ⇒ gate_skip with ZERO LLM cost (story AC)', async () => {
    const state = makeState({
      meta: {
        originalRiskDistance: 0.01,
        // Snapshot matching the current facts (same bucket, session, flags):
        // current mid 1.1050 ⇒ r = 0.50 ⇒ bucket 1, same as 0.6.
        supervisionSnapshot: {
          rMultiple: 0.6,
          sessionLabel: 'LONDON',
          liquidityRegime: 'NORMAL',
          holdingHours: 3,
          tripleSwapAhead: false,
          weekendGapWindow: false,
          highImpactEventWithinBlackout: false,
        },
      },
    });
    const deps = makeDeps(state);
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('gate_skip');
    expect(state.llmCalls).toBe(0);
    const skip = state.audits.find((a) => a.action === 'supervision_gate_skip');
    expect(skip).toBeDefined();
    expect(skip?.llmCost).toBe(0);
  });

  it('material change ⇒ exactly one validated LLM call + supervision row', async () => {
    const state = makeState(); // no snapshot ⇒ first_supervision is material
    const deps = makeDeps(state);
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('llm_hold');
    expect(state.llmCalls).toBe(1);
    expect(state.supervisions).toHaveLength(1);
    expect(state.supervisions[0]?.action).toBe('hold');
    // Snapshot persisted for the next diff.
    expect(state.tradeUpdates.length).toBeGreaterThan(0);
  });

  it('schema-invalid LLM output degrades to HOLD (never throws, never applies)', async () => {
    const state = makeState();
    state.llmResponse = JSON.stringify({ action: 'YOLO_DOUBLE_DOWN', confidence: 2 });
    const deps = makeDeps(state);
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('schema_invalid');
    expect(state.supervisions[0]?.action).toBe('hold');
    expect(state.supervisions[0]?.applied).toBe(false);
    expect(state.closedTrades).toHaveLength(0);
  });

  it('CLOSE decision closes via the execution channel and is applied', async () => {
    const state = makeState();
    state.llmResponse = JSON.stringify({
      action: 'CLOSE',
      confidence: 0.9,
      rationale: 'regime flipped against the position',
    });
    const deps = makeDeps(state);
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('llm_action');
    expect(state.closedTrades).toHaveLength(1);
    expect(state.supervisions[0]?.action).toBe('close');
    expect(state.supervisions[0]?.applied).toBe(true);
  });

  it('TIGHTEN_STOP never widens the stop', async () => {
    // Long at 1.1, current 1.105 ⇒ proposal = 1.105 − 0.5×0.01 = 1.1; existing
    // SL already AT 1.104 (tighter) ⇒ refuse to widen; applied=false.
    const state = makeState({ stopLoss: 1.104 });
    state.llmResponse = JSON.stringify({
      action: 'TIGHTEN_STOP',
      confidence: 0.8,
      rationale: 'lock in gains',
    });
    const deps = makeDeps(state);
    await processSupervisionJob(deps, { tradeId: 't1' });
    expect(state.modifies).toHaveLength(0);
    expect(state.supervisions[0]?.applied).toBe(false);
  });

  it('layered exit fires BEFORE the gate/LLM (price beyond stop)', async () => {
    const state = makeState();
    // Push price through the stop.
    const deps = makeDeps(state);
    (deps.prisma as unknown as { tick: { findFirst: () => Promise<unknown> } }).tick.findFirst =
      async () => ({ bid: 1.0889, ask: 1.0891, ts: new Date() });
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('layer_exit');
    expect(outcome.layer).toBe('hard_sl_tp');
    expect(state.llmCalls).toBe(0);
    expect(state.closedTrades).toHaveLength(1);
  });

  it('halt/kill-switch pauses supervision', async () => {
    const state = makeState();
    const deps = makeDeps(state, {
      killSwitch: { isActive: async () => true } as never,
    });
    const outcome = await processSupervisionJob(deps, { tradeId: 't1' });
    expect(outcome.outcome).toBe('skipped_halt');
  });
});

describe('helpers', () => {
  it('supervisionConfigFromEnv threads env limits through', () => {
    const { exits, gate } = supervisionConfigFromEnv(BASE_ENV);
    expect(exits.timeStopHours).toBe(72);
    expect(exits.dailyDrawdownHaltPct).toBe(0.05);
    expect(gate.adverseR).toBe(-0.75);
  });

  it('tripleSwapAhead requires >2 days held AND a Wednesday rollover next', () => {
    // Held 1 day — never true regardless of weekday.
    expect(
      tripleSwapAhead(new Date('2026-07-07T10:00:00Z'), new Date('2026-07-08T10:00:00Z')),
    ).toBe(false);
    // Held >2 days, evaluated Wednesday 2026-07-08 before 17:00 NY (14:00 UTC ⇒ 10:00 NY).
    expect(
      tripleSwapAhead(new Date('2026-07-03T10:00:00Z'), new Date('2026-07-08T14:00:00Z')),
    ).toBe(true);
    // Same holding, evaluated Friday — next rollover is not Wednesday.
    expect(
      tripleSwapAhead(new Date('2026-07-03T10:00:00Z'), new Date('2026-07-10T14:00:00Z')),
    ).toBe(false);
  });
});
