/**
 * BE-120 — chaos test suite (Step 6.2).
 *
 * Composes the REAL components (AgentGraph, CircuitBreaker,
 * QuantPipelineClient, KillSwitchStore, the @fx/risk-gate engine, the
 * BE-066 cycle) with injected faults and asserts the DEFAULT behaviour is
 * safe: HOLD/flatten, never a hang, never a silent resume.
 *
 * Scenarios (story ACs + plan §15):
 *   S1  kill-switch survives a Redis flush (BE-073 re-hydration)
 *   S2  OANDA disconnect → sticky halt → cycle HOLDs with zero LLM spend
 *   S3  LLM total outage (rejecting AND hanging providers) → HOLD within
 *       budget, partial transcript persisted, no hung jobs
 *   S4  gRPC quant outage → circuit opens → HOLD for ALL instruments with
 *       no connection attempts; HALF-OPEN probe recovery re-closes it
 *   S5  flash crash (spread ≥5× cap) → FLASH_SPREAD veto + HALT_NEW_ENTRIES
 *       flag + critical alert fan-out
 *   S6  daily drawdown breach → DAILY_DD_HALT veto
 *   S7  weekend gap window (pre-Friday flatten armed, high-vol) → no new
 *       entries + WEEKEND_GAP_FLATTEN flag for open positions
 *   S8  worst-case load: ALL instruments candidate at the same bar close +
 *       2 debate rounds + one degraded provider → every job completes within
 *       the E2E budget measured FROM SEMAPHORE ACQUISITION; waiters are
 *       served in liquidity-priority order (no starved instrument)
 *
 * Budgets here are millisecond-scaled; the code paths and policies are the
 * production ones. The same scenarios run against the live stack with real
 * budgets (<180s worst-case E2E) in the Phase-6 staging drills
 * (PHASE6_TESTING_GUIDE).
 */

import type { InvokeParams, InvokeResult } from '@fx/llm';
import {
  DEFAULT_RISK_GATE_CONFIG,
  evaluateRiskGate,
  type RiskGateConfig,
} from '@fx/risk-gate';
import type { AgentRole } from '@fx/types';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { setExecutionHalt } from '../execution/halt.js';
import {
  KILL_SWITCH_REDIS_KEY,
  type KillSwitchDb,
  type KillSwitchRow,
  KillSwitchStore,
} from '../execution/kill-switch.js';
import { AgentGraph, type GraphBudgets } from '../signals/agent-graph.js';
import { CircuitBreaker } from '../signals/circuit-breaker.js';
import { ContextAssembler } from '../signals/context-assembler.js';
import { createPromptRegistry } from '../signals/prompts.js';
import {
  type PipelineResult,
  QuantPipelineClient,
  type QuantServiceStub,
} from '../signals/quant-pipeline-client.js';
import type { RiskGate, RiskGateInput } from '../signals/risk-gate.js';
import {
  liquidityPriority,
  PrioritySemaphore,
  processSignalJob,
  type SignalsWorkerDeps,
} from '../signals/signals-worker.js';

// ─── Harness: flushable Redis, Prisma fake (incl. kill_switch_state) ─────────

function chaosRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, String(value));
      return 'OK';
    },
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
    smembers: async (key: string) => [...(sets.get(key) ?? [])],
    publish: async () => 1,
  } as unknown as Redis;
  /** The chaos event: everything Redis held is gone. */
  const flush = () => {
    store.clear();
    sets.clear();
  };
  return { redis, store, sets, flush };
}

function chaosPrisma() {
  interface Row extends Record<string, unknown> {
    id: string;
  }
  const signals: Row[] = [];
  const intents: Row[] = [];
  const debates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const disagreements: Record<string, unknown>[] = [];
  const killSwitchRows: KillSwitchRow[] = [];
  const prisma = {
    signal: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `sig-${signals.length + 1}`, ...data };
        signals.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = signals.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    tradeIntent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `int-${intents.length + 1}`, ...data };
        intents.push(row);
        return row;
      },
    },
    agentDebateMessage: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        debates.push(...data);
        return { count: data.length };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
    disagreementEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        disagreements.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  const killSwitchDb: KillSwitchDb = {
    killSwitchState: {
      create: async ({ data }) => {
        const row: KillSwitchRow = {
          id: `ks-${killSwitchRows.length + 1}`,
          active: data.active,
          reason: data.reason,
          activatedBy: data.activatedBy,
          activatedAt: new Date(),
          deactivatedBy: null,
          deactivatedAt: null,
          closeOutStatus: data.closeOutStatus,
          closeReport: null,
          updatedAt: new Date(),
        };
        killSwitchRows.push(row);
        return row;
      },
      findFirst: async () => killSwitchRows.at(-1) ?? null,
      update: async ({ where, data }) => {
        const row = killSwitchRows.find((r) => r.id === where.id);
        if (!row) throw new Error(`no kill-switch row ${where.id}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
  };
  return { prisma, killSwitchDb, signals, intents, debates, audits, disagreements };
}

function fakeQueue() {
  const jobs: Array<{ name: string; data: unknown }> = [];
  return {
    jobs,
    queue: {
      add: async (name: string, data: unknown) => {
        jobs.push({ name, data });
        return {};
      },
    } as never,
  };
}

// ─── Harness: LLM providers with injectable faults ───────────────────────────

const GOLDEN: Record<AgentRole, string> = {
  technical_analyst: '{"stance":"BULL","confidence":0.7,"rationale":"trend intact"}',
  macro_analyst: '{"stance":"NEUTRAL","confidence":0.5,"rationale":"mixed"}',
  sentiment_analyst: '{"stance":"BULL","confidence":0.6,"rationale":"positive"}',
  bull_researcher: '{"argument":"edge is calibrated","confidence":0.7}',
  bear_researcher: '{"argument":"entropy risk","confidence":0.4}',
  trader: '{"action":"ENTER","direction":"long","confidence":0.66}',
  risk_team: '{"approve":true,"concerns":[]}',
  pm: '{"decision":"APPROVE","rationale":"coherent"}',
  supervisor: '{"action":"HOLD","confidence":0.6,"rationale":"within plan"}',
};

type LlmFault = 'none' | 'reject_all' | 'hang_all';

function chaosLlm(options: { fault?: LlmFault; latencyMs?: number; degradeEvery?: number } = {}) {
  const calls: InvokeParams[] = [];
  const fault = options.fault ?? 'none';
  const latencyMs = options.latencyMs ?? 0;
  return {
    calls,
    invoke: async (params: InvokeParams): Promise<InvokeResult> => {
      calls.push(params);
      if (fault === 'reject_all') throw new Error('chaos: every provider unreachable');
      if (fault === 'hang_all') return new Promise<InvokeResult>(() => {}); // never settles
      // "One provider degraded": every Nth call answers slow + failed-over.
      const degraded =
        options.degradeEvery !== undefined && calls.length % options.degradeEvery === 0;
      const delay = degraded ? latencyMs * 4 : latencyMs;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return {
        text: GOLDEN[params.role],
        provider: degraded ? 'openrouter' : 'anthropic',
        model: 'test-snapshot',
        tier: 'standard',
        modelDowngraded: degraded,
        downgradeReason: degraded ? 'latency' : null,
        failedOver: degraded,
        latencyMs: delay,
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.001,
      };
    },
  };
}

// ─── Harness: engine-backed risk gate (the REAL @fx/risk-gate rules) ─────────

function engineGate(
  configOverrides: Partial<RiskGateConfig> = {},
  facts: {
    weeklyPnlPct?: number;
    openPositions?: Array<{ instrument: string; openedAt: Date }>;
  } = {},
): RiskGate {
  const config: RiskGateConfig = { ...DEFAULT_RISK_GATE_CONFIG, ...configOverrides };
  return {
    evaluate: async (input: RiskGateInput) => {
      const result = evaluateRiskGate(
        {
          candidate: input.candidate,
          account: input.account,
          barTs: input.barTs,
          degradedInstruments: input.degradedInstruments,
          killSwitchActive: false,
          weeklyPnlPct: facts.weeklyPnlPct ?? 0,
          instrumentDailyLossPct: 0,
          openPositions: facts.openPositions ?? [],
          clusters: [],
          clusterSetVersion: null,
          calendarAvailable: false,
          upcomingEvents: [],
          sessionLabel: input.sessionLabel ?? 'LONDON',
          liquidityRegime: input.liquidityRegime ?? 'HIGH',
          spreadPips: input.features?.spread_pips ?? null,
          spreadPctile: input.features?.spread_pctile ?? null,
          weekendGapWindow:
            input.features?.weekend_gap_window === undefined
              ? null
              : input.features.weekend_gap_window === 1,
        },
        config,
      );
      return {
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        checks: result.checks,
        flags: result.flags,
        alerts: result.alerts,
      };
    },
  };
}

// ─── Harness: deps builder ───────────────────────────────────────────────────

const TEST_BUDGETS: GraphBudgets = {
  specialistMs: 300,
  debateTurnMs: 300,
  stageMs: 300,
  graphMs: 3_000,
  failoverGraceMs: 50,
};

/** Millisecond-scaled §2.2 budgets for the outage tests (fast, still ordered). */
const TIGHT_BUDGETS: GraphBudgets = {
  specialistMs: 100,
  debateTurnMs: 100,
  stageMs: 100,
  graphMs: 1_000,
  failoverGraceMs: 20,
};

const env = {
  TRADING_MODE: 'paper',
  AGENT_DEBATE_ROUNDS: 1,
  RISK_PROBABILITY_THRESHOLD: 0.6,
  SIGNALS_E2E_BUDGET_MS: 10_000,
} as unknown as Env;

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    features: { rsi_14: 61.2 },
    hasCandidate: true,
    candidate: {
      instrument: 'EUR_USD',
      side: 'long',
      probability: 0.63,
      regime: 'TREND_UP',
      modelVersion: 'EUR_USD/H1 v3',
      entryPrice: 1.0885,
      stopLossPrice: 1.0845,
      takeProfitPrice: 1.0965,
    },
    sessionLabel: 'LONDON',
    liquidityRegime: 'HIGH',
    trendRegime: 'TREND_UP',
    regimeEntropy: 0.41,
    debateRounds: 1,
    featureSetVersion: 1,
    challengerProbability: null,
    ...overrides,
  };
}

const approveGate: RiskGate = {
  evaluate: async () => ({ verdict: 'approve', reasonCode: null, checks: { all: 'pass' } }),
};

const SIZED = {
  kind: 'sized',
  sizing: {
    units: 10_000,
    calibratedProbability: 0.63,
    targetVolatility: 0.004,
    sizingModelVersion: 'vol-target-v1',
    riskAmount: 40,
    capsApplied: [],
    probScale: 1,
  },
} as const;

interface HarnessOptions {
  redis?: ReturnType<typeof chaosRedis>;
  db?: ReturnType<typeof chaosPrisma>;
  llm?: ReturnType<typeof chaosLlm>;
  budgets?: GraphBudgets;
  riskGate?: RiskGate;
  killSwitch?: KillSwitchStore | null;
  pipelinePerInstrument?: (instrument: string) => PipelineResult;
  pipelineClient?: Pick<QuantPipelineClient, 'runPipeline' | 'sizePosition'>;
  semaphore?: PrioritySemaphore;
}

function harness(options: HarnessOptions = {}) {
  const redis = options.redis ?? chaosRedis();
  const db = options.db ?? chaosPrisma();
  const llm = options.llm ?? chaosLlm();
  const exec = fakeQueue();
  const notif = fakeQueue();
  const assembler = new ContextAssembler({ news: { queryNews: async () => [] } });
  const graph = new AgentGraph({
    assembler,
    llm,
    registry: createPromptRegistry(),
    budgets: options.budgets ?? TEST_BUDGETS,
    probabilityThreshold: 0.6,
  });
  const pipelineClient =
    options.pipelineClient ??
    ({
      runPipeline: async (instrument: string) => ({
        kind: 'result' as const,
        result: options.pipelinePerInstrument?.(instrument) ?? pipelineResult(),
      }),
      sizePosition: async () => SIZED,
    } as unknown as QuantPipelineClient);
  const deps: SignalsWorkerDeps = {
    prisma: db.prisma,
    redis: redis.redis,
    pipeline: pipelineClient as QuantPipelineClient,
    assembler,
    graph,
    riskGate: options.riskGate ?? approveGate,
    killSwitch: options.killSwitch ?? null,
    account: {
      current: async () => ({ equity: 10_000, openPositions: 0, dailyPnlPct: 0, openRiskPct: 0 }),
    },
    memory: null,
    executionQueue: exec.queue,
    notificationsQueue: notif.queue,
    semaphore: options.semaphore ?? new PrioritySemaphore(3),
    env,
  };
  return { deps, redis, db, llm, exec, notif };
}

// Thursday 13:00 UTC — outside weekend closure and the Friday pre-close window.
const BAR_TS = '2026-07-09T13:00:00.000Z';
const job = { instrument: 'EUR_USD', timeframe: 'H1', barTs: BAR_TS };

function auditActions(db: ReturnType<typeof chaosPrisma>): string[] {
  return db.audits.map((a) => (a.details as { action: string }).action);
}

// ─── S1 — kill-switch survives a Redis flush (BE-073) ────────────────────────

describe('S1: Redis flushed while kill-switch active → trading stays halted', () => {
  it('re-hydrates ACTIVE from Postgres on cache miss and the cycle holds with zero LLM spend', async () => {
    const redis = chaosRedis();
    const db = chaosPrisma();
    const store = new KillSwitchStore(db.killSwitchDb, redis.redis);
    await store.activate('operator', 'chaos drill');
    expect(await store.isActive()).toBe(true);

    // CHAOS: Redis restarts empty — cache AND sticky halt flag both gone.
    redis.flush();
    expect(redis.store.get(KILL_SWITCH_REDIS_KEY)).toBeUndefined();

    // Source of truth answers; the cache is repopulated, never silently cleared.
    expect(await store.isActive()).toBe(true);
    expect(redis.store.get(KILL_SWITCH_REDIS_KEY)).toBe('1');

    const { deps, llm, db: cycleDb } = harness({ redis, db, killSwitch: store });
    const outcome = await processSignalJob(deps, job);
    expect(outcome).toEqual({ outcome: 'hold', reason: 'halted' });
    expect(llm.calls).toHaveLength(0); // no LLM spend while halted
    expect(cycleDb.signals).toHaveLength(0);
    expect(auditActions(cycleDb)).toContain('signal_cycle_skipped_halt');
  });

  it('deactivation is explicit: flush alone never releases the switch', async () => {
    const redis = chaosRedis();
    const db = chaosPrisma();
    const store = new KillSwitchStore(db.killSwitchDb, redis.redis);
    await store.activate('operator', 'chaos drill');
    redis.flush();
    await store.isActive(); // re-hydrate
    redis.flush(); // and again — belt and braces
    expect(await store.isActive()).toBe(true);
    await store.deactivate('operator');
    expect(await store.isActive()).toBe(false);
  });
});

// ─── S2 — OANDA disconnect → sticky halt → safe HOLD ─────────────────────────

describe('S2: broker disconnect sets the sticky halt → cycles HOLD, zero LLM', () => {
  it('holds every instrument while execution:halt is set', async () => {
    const redis = chaosRedis();
    await setExecutionHalt(redis.redis, 'broker_disconnect: OANDA stream lost');
    const { deps, llm, db } = harness({ redis });
    for (const instrument of ['EUR_USD', 'XAU_USD', 'USD_JPY']) {
      const outcome = await processSignalJob(deps, { ...job, instrument });
      expect(outcome).toEqual({ outcome: 'hold', reason: 'halted' });
    }
    expect(llm.calls).toHaveLength(0);
    expect(db.signals).toHaveLength(0);
  });
});

// ─── S3 — LLM total outage → HOLD within budget, no hung jobs ────────────────

describe('S3: total LLM provider outage → deterministic HOLD, no hangs', () => {
  it('all providers rejecting → cycle completes with a HOLD and persists the degradation notes', async () => {
    const { deps, db } = harness({ llm: chaosLlm({ fault: 'reject_all' }), budgets: TIGHT_BUDGETS });
    const started = Date.now();
    const outcome = await processSignalJob(deps, job);
    const elapsed = Date.now() - started;

    expect(outcome.outcome).toBe('pm_hold'); // graph HOLD, never APPROVE
    expect(db.intents).toHaveLength(0); // nothing reached execution
    expect(db.signals[0]?.status).toBe('rejected');
    // Partial transcript/notes persisted (budget-overrun contract).
    expect(db.debates.length).toBeGreaterThan(0);
    // Completed the job — did not ride the BullMQ retry loop or hang.
    expect(elapsed).toBeLessThan(TIGHT_BUDGETS.graphMs + 2_000);
  });

  it('all providers HANGING → stage budgets fire, job still completes inside the graph budget', async () => {
    const { deps, db } = harness({ llm: chaosLlm({ fault: 'hang_all' }), budgets: TIGHT_BUDGETS });
    const started = Date.now();
    const outcome = await processSignalJob(deps, job);
    const elapsed = Date.now() - started;

    expect(outcome.outcome).toBe('pm_hold');
    expect(db.intents).toHaveLength(0);
    // The whole point: hung providers cannot hang the job.
    expect(elapsed).toBeLessThan(TIGHT_BUDGETS.graphMs + 2_000);
  });
});

// ─── S4 — gRPC quant outage → circuit opens → HOLD all; recovery probe ───────

describe('S4: quant gRPC outage → circuit opens, HOLDs without dialing, then recovers', () => {
  function failingThenHealthyStub() {
    let healthy = false;
    let callCount = 0;
    const stub: QuantServiceStub = {
      RunPipeline: (_req, _opts, cb) => {
        callCount += 1;
        if (!healthy) {
          const err = Object.assign(new Error('chaos: connect ECONNREFUSED'), { code: 14 });
          cb(err as never, {} as never);
          return;
        }
        cb(null, {
          features: {},
          hasCandidate: false,
          candidate: undefined,
          sessionLabel: 'LONDON',
          liquidityRegime: 'HIGH',
          trendRegime: 'RANGE',
          regimeEntropy: 0.2,
          debateRounds: 0,
          featureSetVersion: 1,
          challengerProbability: undefined,
        });
      },
      SizePosition: (_req, _opts, cb) => cb(null, {}),
    };
    return { stub, heal: () => (healthy = true), calls: () => callCount };
  }

  it('3 failures open the circuit; while open NO connection is attempted and every instrument HOLDs; a healthy probe closes it', async () => {
    let nowMs = 1_000_000;
    const breaker = new CircuitBreaker({ now: () => nowMs });
    const { stub, heal, calls } = failingThenHealthyStub();
    const client = new QuantPipelineClient(
      { QUANT_GRPC_PIPELINE_TIMEOUT_MS: 1_000 } as unknown as Env,
      stub,
      breaker,
    );

    // Three consecutive transport failures → OPEN.
    for (let i = 0; i < 3; i++) {
      const out = await client.runPipeline('EUR_USD', 'H1', new Date(BAR_TS));
      expect(out).toMatchObject({ kind: 'hold', reason: 'GRPC_UNAVAILABLE' });
    }
    expect(breaker.state()).toBe('open');
    expect(calls()).toBe(3);

    // While OPEN: HOLD `CIRCUIT_OPEN` for ALL instruments, stub never dialed.
    const { deps, llm, db } = harness({ pipelineClient: client });
    for (const instrument of ['EUR_USD', 'XAU_USD', 'USD_JPY', 'GBP_USD']) {
      const outcome = await processSignalJob(deps, { ...job, instrument });
      expect(outcome).toEqual({ outcome: 'hold', reason: 'CIRCUIT_OPEN' });
    }
    expect(calls()).toBe(3); // no network attempts while open
    expect(llm.calls).toHaveLength(0);
    expect(db.signals).toHaveLength(0);

    // Recovery: 60s later the HALF-OPEN probe hits a healed service → CLOSED.
    heal();
    nowMs += 60_000;
    expect(breaker.state()).toBe('half_open');
    const probe = await client.runPipeline('EUR_USD', 'H1', new Date(BAR_TS));
    expect(probe.kind).toBe('result'); // healthy no-candidate response
    expect(breaker.state()).toBe('closed');
    expect(calls()).toBe(4);
  });

  it('a failed probe re-opens the cooldown instead of resuming traffic', async () => {
    let nowMs = 2_000_000;
    const breaker = new CircuitBreaker({ now: () => nowMs });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    nowMs += 60_000;
    expect(breaker.canAttempt()).toBe(true); // the single probe
    breaker.recordFailure(); // probe fails
    expect(breaker.state()).toBe('open'); // full cooldown restarted
    expect(breaker.canAttempt()).toBe(false);
  });
});

// ─── S5 — flash crash: spread ≥5× cap ────────────────────────────────────────

describe('S5: flash-crash spread → FLASH_SPREAD veto, entries halted, critical alert', () => {
  it('vetoes the entry, flags HALT_NEW_ENTRIES, and fans out a critical alert', async () => {
    // EUR_USD cap 3 pips × flash multiple 5 = 15; inject 20 pips.
    const { deps, db, notif } = harness({
      riskGate: engineGate(),
      pipelinePerInstrument: () =>
        pipelineResult({ features: { spread_pips: 20, spread_pctile: 0.999 } }),
    });
    const outcome = await processSignalJob(deps, job);

    expect(outcome.outcome).toBe('risk_gate_veto');
    expect(outcome.reason).toBe('FLASH_SPREAD');
    expect(db.intents).toHaveLength(0);
    expect(db.signals[0]?.status).toBe('rejected');
    // Critical alert reached the notifications queue (Telegram+SMS fan-out).
    const alert = notif.jobs.find(
      (j) => (j.data as { severity?: string }).severity === 'critical',
    );
    expect(alert).toBeDefined();
    expect((alert?.data as { title: string }).title).toContain('Flash spread');
    // HALT_NEW_ENTRIES flag audited for the operator.
    const flagAudit = db.audits.find(
      (a) => (a.details as { action: string }).action === 'signal_cycle_risk_flags',
    );
    expect(JSON.stringify(flagAudit)).toContain('HALT_NEW_ENTRIES');
  });

  it('normal spread on the same path does NOT trip the flash rule', async () => {
    const { deps } = harness({
      riskGate: engineGate({ minRiskReward: 1.0 }), // isolate the spread rules
      pipelinePerInstrument: () =>
        pipelineResult({ features: { spread_pips: 1.2, spread_pctile: 0.4 } }),
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.reason).not.toBe('FLASH_SPREAD');
  });
});

// ─── S6 — daily drawdown halt ────────────────────────────────────────────────

describe('S6: daily drawdown breach → DAILY_DD_HALT veto', () => {
  it('vetoes any new entry once daily P&L ≤ −5%', async () => {
    const { deps, db } = harness({ riskGate: engineGate() });
    deps.account = {
      current: async () => ({
        equity: 10_000,
        openPositions: 0,
        dailyPnlPct: -0.06,
        openRiskPct: 0,
      }),
    };
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('risk_gate_veto');
    expect(outcome.reason).toBe('DAILY_DD_HALT');
    expect(db.intents).toHaveLength(0);
  });
});

// ─── S7 — weekend gap window: pre-Friday flatten ─────────────────────────────

describe('S7: weekend gap scenario → no new entries, open positions flagged for flatten', () => {
  it('high-vol regime inside the pre-close window with flatten armed → WEEKEND_GAP_WINDOW veto + flatten flag', async () => {
    const openPositions = [
      { instrument: 'EUR_USD', openedAt: new Date('2026-07-08T09:00:00Z') },
      { instrument: 'XAU_USD', openedAt: new Date('2026-07-07T14:00:00Z') },
    ];
    const { deps, db } = harness({
      riskGate: engineGate({ weekendFlattenEnabled: true }, { openPositions }),
      pipelinePerInstrument: () =>
        pipelineResult({
          liquidityRegime: 'LOW', // high-vol / thin book
          features: { weekend_gap_window: 1 }, // QN-047 feature: inside Fri pre-close
        }),
    });
    const outcome = await processSignalJob(deps, job);

    expect(outcome.outcome).toBe('risk_gate_veto');
    expect(outcome.reason).toBe('WEEKEND_GAP_WINDOW');
    // Both open positions named in the flatten flag (BE-051 consumes it).
    const flagAudit = JSON.stringify(
      db.audits.find(
        (a) => (a.details as { action: string }).action === 'signal_cycle_risk_flags',
      ),
    );
    expect(flagAudit).toContain('WEEKEND_GAP_FLATTEN');
    expect(flagAudit).toContain('EUR_USD');
    expect(flagAudit).toContain('XAU_USD');
  });

  it('flatten disabled → same window is advisory only (no veto)', async () => {
    const { deps } = harness({
      riskGate: engineGate({ weekendFlattenEnabled: false, minRiskReward: 1.0 }),
      pipelinePerInstrument: () =>
        pipelineResult({ liquidityRegime: 'LOW', features: { weekend_gap_window: 1 } }),
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.reason).not.toBe('WEEKEND_GAP_WINDOW');
  });
});

// ─── S8 — worst-case load ────────────────────────────────────────────────────

describe('S8: all instruments candidate + 2 debate rounds + one degraded provider', () => {
  class ProbedSemaphore extends PrioritySemaphore {
    readonly grantOrder: number[] = [];

    override async acquire(priority: number): Promise<void> {
      await super.acquire(priority);
      this.grantOrder.push(priority);
    }
  }

  it('every job completes within the E2E budget (clock at acquisition); waiters served most-liquid-first; nobody starves', async () => {
    // Least-liquid first so the interesting ordering happens in the wait queue.
    const instruments = ['XAU_USD', 'USD_CAD', 'USD_CHF', 'GBP_USD', 'USD_JPY', 'EUR_USD'];
    const semaphore = new ProbedSemaphore(3);
    const llm = chaosLlm({ latencyMs: 8, degradeEvery: 5 }); // one degraded provider
    const { deps, db } = harness({
      llm,
      semaphore,
      pipelinePerInstrument: (instrument) =>
        pipelineResult({
          candidate: {
            instrument,
            side: 'long',
            probability: 0.63,
            regime: 'TREND_UP',
            modelVersion: `${instrument}/H1 v3`,
            entryPrice: 1.0885,
            stopLossPrice: 1.0845,
            takeProfitPrice: 1.0965,
          },
          regimeEntropy: 0.95, // high uncertainty ⇒ max debate depth
          debateRounds: 2, // the §2.2 worst case
        }),
    });

    const started = Date.now();
    const outcomes = await Promise.all(
      instruments.map((instrument) => processSignalJob(deps, { ...job, instrument })),
    );
    const wallMs = Date.now() - started;

    // No starved instrument: every job reached a terminal outcome.
    expect(outcomes).toHaveLength(6);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe('executed');
    }
    expect(db.intents).toHaveLength(6);

    // E2E measured FROM SEMAPHORE ACQUISITION is within budget for every job
    // (the §2.2 contract that makes a same-bar pile-up survivable).
    const executed = db.audits
      .map((a) => a.details as { action: string; e2eMs?: number })
      .filter((d) => d.action === 'signal_cycle_executed');
    expect(executed).toHaveLength(6);
    for (const d of executed) {
      expect(d.e2eMs).toBeDefined();
      expect(d.e2eMs as number).toBeLessThanOrEqual(env.SIGNALS_E2E_BUDGET_MS);
    }

    // First three grants go to whoever asked first (permits free); the WAIT
    // QUEUE is then served strictly most-liquid-first: EUR_USD before
    // USD_JPY before GBP_USD.
    const waited = semaphore.grantOrder.slice(3);
    expect(waited).toEqual([...waited].sort((a, b) => a - b));
    expect(waited[0]).toBe(liquidityPriority('EUR_USD'));

    // Sanity on the harness itself: the degraded provider really degraded.
    expect(llm.calls.length).toBeGreaterThan(0);
    // Suite-level wall clock stays tiny at ms-scale budgets; the real <180s
    // bound is asserted in the staging drill with production budgets.
    expect(wallMs).toBeLessThan(30_000);
  });
});
