/** BE-068 — circuit breaker + RunPipeline HOLD semantics (fake stub, fake clock). */

import * as grpc from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  QuantPipelineClient,
  type QuantServiceStub,
  type RunPipelineOutcome,
} from './quant-pipeline-client.js';

const env = { QUANT_GRPC_PIPELINE_TIMEOUT_MS: 30_000, QUANT_GRPC_URL: 'test:0' } as Env;

type StubBehavior =
  | { kind: 'ok'; response?: Record<string, unknown> }
  | { kind: 'error'; code: grpc.status };

function fakeStub(behaviors: StubBehavior[]): { stub: QuantServiceStub; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    stub: {
      RunPipeline: (_req, _opts, cb) => {
        calls.push(Date.now());
        const behavior = behaviors[Math.min(i, behaviors.length - 1)];
        i += 1;
        if (!behavior) throw new Error('no behavior');
        if (behavior.kind === 'error') {
          cb({ code: behavior.code, message: `code ${behavior.code}` } as grpc.ServiceError, {});
        } else {
          cb(null, behavior.response ?? okResponse);
        }
      },
    },
  };
}

const okResponse: Record<string, unknown> = {
  features: { atr_14: 0.002 },
  hasCandidate: true,
  candidate: {
    instrument: 'EUR_USD',
    side: 1,
    probability: 0.62,
    regime: 'TREND_UP/NORMAL',
    modelVersion: 'v3',
    entryPrice: 1.08,
    stopLossPrice: 1.07,
    takeProfitPrice: 1.1,
  },
  sessionLabel: 'LONDON',
  liquidityRegime: 'HIGH',
  trendRegime: 'TREND_UP',
  regimeEntropy: 0.4,
  debateRounds: 1,
  featureSetVersion: 3,
  challengerProbability: 0.6,
};

function run(client: QuantPipelineClient): Promise<RunPipelineOutcome> {
  return client.runPipeline('EUR_USD', 'H1', new Date('2026-07-09T14:00:00Z'));
}

describe('CircuitBreaker (§2.2 parameters)', () => {
  it('opens after 3 consecutive failures and admits nothing for 60s', () => {
    let t = 0;
    const breaker = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
    t = 59_999;
    expect(breaker.canAttempt()).toBe(false);
  });

  it('half-opens after 60s, closes on probe success', () => {
    let t = 0;
    const breaker = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    t = 60_000;
    expect(breaker.state()).toBe('half_open');
    expect(breaker.canAttempt()).toBe(true); // the probe
    expect(breaker.canAttempt()).toBe(false); // only one probe at a time
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('failed probe reopens for another 60s', () => {
    let t = 0;
    const breaker = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    t = 60_000;
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    t = 119_999;
    expect(breaker.canAttempt()).toBe(false);
    t = 120_000;
    expect(breaker.canAttempt()).toBe(true);
  });

  it('failures outside the 5-min window do not accumulate', () => {
    let t = 0;
    const breaker = new CircuitBreaker({ now: () => t });
    breaker.recordFailure();
    breaker.recordFailure();
    t = 5 * 60_000 + 1; // first two age out
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('a success resets the consecutive count', () => {
    const breaker = new CircuitBreaker({ now: () => 0 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });
});

describe('QuantPipelineClient (BE-068)', () => {
  it('maps a successful RunPipeline response', async () => {
    const { stub } = fakeStub([{ kind: 'ok' }]);
    const outcome = await run(new QuantPipelineClient(env, stub));
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.result.candidate).toMatchObject({
        instrument: 'EUR_USD',
        side: 'long',
        probability: 0.62,
      });
      expect(outcome.result.debateRounds).toBe(1);
      expect(outcome.result.challengerProbability).toBe(0.6);
    }
  });

  it('DEADLINE_EXCEEDED → HOLD GRPC_TIMEOUT, counted by the breaker; never throws', async () => {
    const { stub } = fakeStub([{ kind: 'error', code: grpc.status.DEADLINE_EXCEEDED }]);
    const client = new QuantPipelineClient(env, stub);
    const outcome = await run(client);
    expect(outcome).toMatchObject({ kind: 'hold', reason: 'GRPC_TIMEOUT' });
    await run(client);
    await run(client);
    expect(client.breaker.state()).toBe('open'); // 3 consecutive counted
  });

  it('circuit open → HOLD CIRCUIT_OPEN without attempting the connection', async () => {
    let t = 0;
    const { stub, calls } = fakeStub([{ kind: 'error', code: grpc.status.UNAVAILABLE }]);
    const client = new QuantPipelineClient(env, stub, new CircuitBreaker({ now: () => t }));
    for (let i = 0; i < 3; i++) await run(client);
    expect(calls).toHaveLength(3);
    const outcome = await run(client);
    expect(outcome).toMatchObject({ kind: 'hold', reason: 'CIRCUIT_OPEN' });
    expect(calls).toHaveLength(3); // no 4th connection attempt while open
  });

  it('half-open probe success closes the circuit and resumes normal operation', async () => {
    let t = 0;
    const { stub, calls } = fakeStub([
      { kind: 'error', code: grpc.status.UNAVAILABLE },
      { kind: 'error', code: grpc.status.UNAVAILABLE },
      { kind: 'error', code: grpc.status.UNAVAILABLE },
      { kind: 'ok' },
    ]);
    const client = new QuantPipelineClient(env, stub, new CircuitBreaker({ now: () => t }));
    for (let i = 0; i < 3; i++) await run(client);
    t = 60_001; // cooldown elapsed → probe admitted
    const probe = await run(client);
    expect(probe.kind).toBe('result');
    expect(client.breaker.state()).toBe('closed');
    expect(calls).toHaveLength(4);
  });

  it('FAILED_PRECONDITION (no champion) → HOLD NO_CHAMPION, breaker stays closed', async () => {
    const { stub } = fakeStub([{ kind: 'error', code: grpc.status.FAILED_PRECONDITION }]);
    const client = new QuantPipelineClient(env, stub);
    for (let i = 0; i < 5; i++) {
      const outcome = await run(client);
      expect(outcome).toMatchObject({ kind: 'hold', reason: 'NO_CHAMPION' });
    }
    expect(client.breaker.state()).toBe('closed'); // healthy service, policy HOLD
  });

  it('UNIMPLEMENTED → HOLD GRPC_UNAVAILABLE (Phase-1 contract), no breaker poisoning', async () => {
    const { stub } = fakeStub([{ kind: 'error', code: grpc.status.UNIMPLEMENTED }]);
    const client = new QuantPipelineClient(env, stub);
    const outcome = await run(client);
    expect(outcome).toMatchObject({ kind: 'hold', reason: 'GRPC_UNAVAILABLE' });
    expect(client.breaker.state()).toBe('closed');
  });

  it('no candidate → result with hasCandidate=false and null candidate', async () => {
    const { stub } = fakeStub([
      { kind: 'ok', response: { ...okResponse, hasCandidate: false, candidate: undefined } },
    ]);
    const outcome = await run(new QuantPipelineClient(env, stub));
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.result.hasCandidate).toBe(false);
      expect(outcome.result.candidate).toBeNull();
    }
  });
});
