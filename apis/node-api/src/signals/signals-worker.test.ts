/** BE-066 — entry cycle: gate, budgets, semaphore, risk-gate seam, persistence. */

import type { InvokeParams, InvokeResult } from '@fx/llm';
import type { AgentRole } from '@fx/types';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import { AgentGraph, type GraphBudgets } from './agent-graph.js';
import { ContextAssembler } from './context-assembler.js';
import { createPromptRegistry } from './prompts.js';
import type {
  PipelineResult,
  QuantPipelineClient,
  SizePositionOutcome,
} from './quant-pipeline-client.js';
import { NotImplementedRiskGate, type RiskGate } from './risk-gate.js';
import {
  liquidityPriority,
  PrioritySemaphore,
  processSignalJob,
  type SignalsWorkerDeps,
  sweepTradeOutcomes,
} from './signals-worker.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const GOLDEN: Record<AgentRole, string> = {
  technical_analyst: '{"stance":"BULL","confidence":0.7,"rationale":"trend intact"}',
  macro_analyst: '{"stance":"NEUTRAL","confidence":0.5,"rationale":"mixed"}',
  sentiment_analyst: '{"stance":"BULL","confidence":0.6,"rationale":"positive"}',
  bull_researcher: '{"argument":"edge is calibrated","confidence":0.7}',
  bear_researcher: '{"argument":"entropy risk","confidence":0.4}',
  trader: '{"action":"ENTER","direction":"long","confidence":0.66}',
  risk_team: '{"approve":true,"concerns":[]}',
  pm: '{"decision":"APPROVE","rationale":"coherent"}',
  supervisor: '{"action":"HOLD","confidence":0.6,"rationale":"within plan, no action"}',
};

function fakeLlm(overrides: Partial<Record<AgentRole, string>> = {}) {
  const calls: InvokeParams[] = [];
  return {
    calls,
    invoke: async (params: InvokeParams): Promise<InvokeResult> => {
      calls.push(params);
      return {
        text: overrides[params.role] ?? GOLDEN[params.role],
        provider: 'anthropic',
        model: 'test-snapshot',
        tier: 'standard',
        modelDowngraded: false,
        downgradeReason: null,
        failedOver: false,
        latencyMs: 5,
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.001,
      };
    },
  };
}

function fakePrisma() {
  interface Row extends Record<string, unknown> {
    id: string;
  }
  const signals: Row[] = [];
  const intents: Row[] = [];
  const debates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const disagreements: Record<string, unknown>[] = [];
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
  return { prisma, signals, intents, debates, audits, disagreements };
}

function fakeRedis(overrides: Partial<Record<string, string>> = {}): Redis {
  return {
    get: async (key: string) => overrides[key] ?? null,
    smembers: async () => [],
    publish: async () => 1,
  } as unknown as Redis;
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

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    features: { rsi_14: 61.2, macro_dxy: 104.2, sent_mean_24h: 0.31 },
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

const TEST_BUDGETS: GraphBudgets = {
  specialistMs: 300,
  debateTurnMs: 300,
  stageMs: 300,
  graphMs: 3_000,
  failoverGraceMs: 50,
};

const env = {
  TRADING_MODE: 'paper',
  AGENT_DEBATE_ROUNDS: 1,
  RISK_PROBABILITY_THRESHOLD: 0.6,
  SIGNALS_E2E_BUDGET_MS: 10_000,
} as unknown as Env;

function makeDeps(options: {
  pipeline?: PipelineResult | { hold: string };
  llmOverrides?: Partial<Record<AgentRole, string>>;
  riskGate?: RiskGate;
  sizing?: SizePositionOutcome;
  halted?: boolean;
}) {
  const db = fakePrisma();
  const exec = fakeQueue();
  const notif = fakeQueue();
  const llm = fakeLlm(options.llmOverrides);
  const assembler = new ContextAssembler({ news: { queryNews: async () => [] } });
  const graph = new AgentGraph({
    assembler,
    llm,
    registry: createPromptRegistry(),
    budgets: TEST_BUDGETS,
    probabilityThreshold: 0.6,
  });
  const sizing: SizePositionOutcome =
    options.sizing ??
    ({
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
    } as const);
  const pipelineClient = {
    runPipeline: async () =>
      options.pipeline && 'hold' in options.pipeline
        ? { kind: 'hold' as const, reason: options.pipeline.hold as never, detail: 'x' }
        : {
            kind: 'result' as const,
            result: (options.pipeline as PipelineResult) ?? pipelineResult(),
          },
    sizePosition: async () => sizing,
  } as unknown as QuantPipelineClient;

  const deps: SignalsWorkerDeps = {
    prisma: db.prisma,
    redis: fakeRedis(options.halted ? { 'execution:halt': '1' } : {}),
    pipeline: pipelineClient,
    assembler,
    graph,
    riskGate: options.riskGate ?? approveGate,
    killSwitch: null, // BE-073 store exercised in kill-switch.test.ts
    account: {
      current: async () => ({ equity: 10_000, openPositions: 0, dailyPnlPct: 0, openRiskPct: 0 }),
    },
    memory: null,
    executionQueue: exec.queue,
    notificationsQueue: notif.queue,
    semaphore: new PrioritySemaphore(3),
    env,
  };
  return { deps, db, exec, llm };
}

const job = { instrument: 'EUR_USD', timeframe: 'H1', barTs: '2026-07-09T13:00:00.000Z' };

// ─── Entry gate (ADR-010) ────────────────────────────────────────────────────

describe('entry gate', () => {
  it('no candidate → gate_skip, ZERO LLM calls, no signal row', async () => {
    const { deps, db, llm } = makeDeps({
      pipeline: pipelineResult({ hasCandidate: false, candidate: null }),
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('gate_skip');
    expect(llm.calls).toHaveLength(0);
    expect(db.signals).toHaveLength(0);
    expect(
      db.audits.some((a) => (a.details as { action: string }).action === 'signal_cycle_gate_skip'),
    ).toBe(true);
  });

  it('candidate below the 0.50 pre-filter → gate_skip, zero LLM cost', async () => {
    const base = pipelineResult();
    const { deps, llm } = makeDeps({
      pipeline: pipelineResult({
        candidate: { ...(base.candidate as NonNullable<typeof base.candidate>), probability: 0.45 },
      }),
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('gate_skip');
    expect(llm.calls).toHaveLength(0);
  });

  it('quant HOLD (breaker/timeout/no-champion) → hold, job completes, zero LLM', async () => {
    const { deps, llm } = makeDeps({ pipeline: { hold: 'NO_CHAMPION' } });
    const outcome = await processSignalJob(deps, job);
    expect(outcome).toMatchObject({ outcome: 'hold', reason: 'NO_CHAMPION' });
    expect(llm.calls).toHaveLength(0);
  });

  it('halted execution → cycle skipped before any spend', async () => {
    const { deps, llm } = makeDeps({ halted: true });
    const outcome = await processSignalJob(deps, job);
    expect(outcome).toMatchObject({ outcome: 'hold', reason: 'halted' });
    expect(llm.calls).toHaveLength(0);
  });
});

// ─── Full cycle ──────────────────────────────────────────────────────────────

describe('full cycle', () => {
  it('APPROVE + risk-gate approve → intent created, execution enqueued, signal approved', async () => {
    const { deps, db, exec } = makeDeps({});
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('executed');
    expect(db.signals[0]?.status).toBe('approved');
    expect(db.intents).toHaveLength(1);
    expect(db.intents[0]).toMatchObject({ status: 'approved', units: 10_000, side: 'long' });
    expect(exec.jobs[0]?.data).toEqual({ intentId: 'int-1' });
    // debate transcript persisted (2 turns, 1 round)
    expect(db.debates.length).toBeGreaterThanOrEqual(2);
  });

  it('DEFAULT risk gate (BE-070 pending) fail-safes to VETO — agent APPROVE never executes', async () => {
    const { deps, db, exec } = makeDeps({ riskGate: new NotImplementedRiskGate() });
    const outcome = await processSignalJob(deps, job);
    expect(outcome).toMatchObject({
      outcome: 'risk_gate_veto',
      reason: 'RISK_GATE_NOT_IMPLEMENTED',
    });
    expect(db.intents).toHaveLength(0);
    expect(exec.jobs).toHaveLength(0);
    expect(db.signals[0]?.status).toBe('rejected');
  });

  it('PM veto → signal rejected + disagreement row (QUANT_YES_PM_VETO)', async () => {
    const { deps, db, exec } = makeDeps({
      llmOverrides: { pm: '{"decision":"VETO","rationale":"macro contradicts"}' },
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('pm_veto');
    expect(db.signals[0]?.status).toBe('rejected');
    expect(db.disagreements[0]).toMatchObject({ kind: 'QUANT_YES_PM_VETO', pmDecision: 'VETO' });
    expect(exec.jobs).toHaveLength(0);
  });

  it('trader stage failure → deterministic pm_hold path with reason, debate notes persisted', async () => {
    const { deps, db } = makeDeps({ llmOverrides: { trader: 'not json' } });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('pm_hold');
    expect(outcome.reason).toBe('SCHEMA_INVALID');
    expect(db.signals[0]?.status).toBe('rejected');
  });

  it('zero units from sizing → no intent', async () => {
    const { deps, db } = makeDeps({
      sizing: {
        kind: 'sized',
        sizing: {
          units: 0,
          calibratedProbability: 0.63,
          targetVolatility: 0.004,
          sizingModelVersion: 'v1',
          riskAmount: 0,
          capsApplied: ['min_units'],
          probScale: 1,
        },
      },
    });
    const outcome = await processSignalJob(deps, job);
    expect(outcome.outcome).toBe('zero_units');
    expect(db.intents).toHaveLength(0);
  });
});

// ─── Concurrency (§9.6 cap 3, liquidity priority) ────────────────────────────

describe('PrioritySemaphore', () => {
  it('caps concurrency and wakes waiters by liquidity priority', async () => {
    const sem = new PrioritySemaphore(1);
    await sem.acquire(liquidityPriority('XAU_USD')); // holds the only permit
    const order: string[] = [];
    const waiters = [
      sem.acquire(liquidityPriority('NZD_USD')).then(() => order.push('NZD_USD')),
      sem.acquire(liquidityPriority('EUR_USD')).then(() => order.push('EUR_USD')),
      sem.acquire(liquidityPriority('USD_JPY')).then(() => order.push('USD_JPY')),
    ];
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // everyone queued
    sem.release();
    sem.release();
    sem.release();
    await Promise.all(waiters);
    expect(order).toEqual(['EUR_USD', 'USD_JPY', 'NZD_USD']); // most liquid first
  });

  it('unknown instruments queue last', () => {
    expect(liquidityPriority('EUR_USD')).toBeLessThan(liquidityPriority('EXOTIC_PAIR'));
  });
});

// ─── Outcome sweep (BE-064 phase-2) ──────────────────────────────────────────

describe('sweepTradeOutcomes', () => {
  it('computes R-multiple from intent risk and records via the store', async () => {
    const recorded: Array<{ signalId: string; outcome: Record<string, unknown> }> = [];
    const prisma = {
      trade: {
        findMany: async () => [
          {
            realizedPnl: 80,
            openedAt: new Date('2026-07-09T13:00:00Z'),
            closedAt: new Date('2026-07-10T01:00:00Z'),
            entryPrice: 1.0885,
            meta: { exitReason: 'TP_HIT' },
            intent: { signalId: 'sig-9', entryPrice: 1.0885, stopLoss: 1.0845, units: 10_000 },
          },
        ],
      },
    } as unknown as PrismaClient;
    const store = {
      recordOutcome: async (signalId: string, outcome: Record<string, unknown>) => {
        recorded.push({ signalId, outcome });
        return 1;
      },
    } as never;
    const updated = await sweepTradeOutcomes(prisma, store, new Date());
    expect(updated).toBe(1);
    expect(recorded[0]?.signalId).toBe('sig-9');
    // risk = |1.0885 - 1.0845| * 10000 = 40 → R = 80/40 = 2
    expect(recorded[0]?.outcome.rMultiple).toBeCloseTo(2, 6);
    expect(recorded[0]?.outcome).toMatchObject({ exitReason: 'TP_HIT', holdingHours: 12 });
  });
});
