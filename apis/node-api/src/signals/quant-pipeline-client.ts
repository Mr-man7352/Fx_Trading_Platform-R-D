import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { HoldReason, QuantCandidate, Timeframe } from '@fx/types';
import type { Env } from '../env.js';
import { CircuitBreaker } from './circuit-breaker.js';

/**
 * BE-068 — QuantService `RunPipeline` client with the §2.2 circuit breaker.
 *
 * NEVER throws for operational failures: every outcome is a discriminated
 * union so the signals worker (BE-066) completes its BullMQ job either with
 * a pipeline result or a deterministic HOLD — no unhandled throw, no silent
 * BullMQ retry loop. HOLD-as-default is the seam contracted since Phase 1
 * (QN-004 stubs; the real RPCs return FAILED_PRECONDITION on no-champion).
 */

/** Mirrors proto `RunPipelineResponse` in JS shapes (@fx/types aligned). */
export interface PipelineResult {
  features: Record<string, number>;
  hasCandidate: boolean;
  candidate: QuantCandidate | null;
  sessionLabel: string;
  liquidityRegime: string;
  trendRegime: string;
  regimeEntropy: number;
  debateRounds: number;
  featureSetVersion: number;
  challengerProbability: number | null;
}

export type RunPipelineOutcome =
  | { kind: 'result'; result: PipelineResult }
  | { kind: 'hold'; reason: HoldReason; detail: string };

/** @fx/types Timeframe → proto enum (proto has no W1 — pipeline never runs on it). */
const TIMEFRAME_TO_PROTO: Partial<Record<Timeframe, number>> = {
  M1: 1,
  M5: 2,
  M15: 3,
  M30: 4,
  H1: 5,
  H4: 6,
  D1: 7,
};

const PROTO_TO_SIDE: Record<number, 'long' | 'short'> = { 1: 'long', 2: 'short' };

function protoPath(): string {
  const candidates = [
    resolve(process.cwd(), '../../services/quant/proto/quant.proto'),
    resolve(process.cwd(), 'services/quant/proto/quant.proto'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('quant.proto not found');
}

export type QuantServiceStub = {
  RunPipeline: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
};

export class QuantPipelineClient {
  private readonly stub: QuantServiceStub;
  private readonly timeoutMs: number;
  readonly breaker: CircuitBreaker;

  constructor(env: Env, stub?: QuantServiceStub, breaker?: CircuitBreaker) {
    this.timeoutMs = env.QUANT_GRPC_PIPELINE_TIMEOUT_MS;
    this.breaker = breaker ?? new CircuitBreaker();
    if (stub) {
      this.stub = stub;
      return;
    }
    const def = protoLoader.loadSync(protoPath(), {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [resolve(protoPath(), '..')],
    });
    const pkg = grpc.loadPackageDefinition(def) as unknown as {
      fx: {
        quant: {
          v1: {
            QuantService: new (addr: string, creds: grpc.ChannelCredentials) => QuantServiceStub;
          };
        };
      };
    };
    this.stub = new pkg.fx.quant.v1.QuantService(
      env.QUANT_GRPC_URL,
      grpc.credentials.createInsecure(),
    );
  }

  /**
   * Full deterministic pipeline for one closed bar. Outcomes:
   * - breaker open           → HOLD `CIRCUIT_OPEN` (no connection attempted)
   * - deadline exceeded      → HOLD `GRPC_TIMEOUT`      (breaker failure)
   * - transport error        → HOLD `GRPC_UNAVAILABLE`  (breaker failure)
   * - FAILED_PRECONDITION    → HOLD `NO_CHAMPION`       (service healthy — no failure)
   * - UNIMPLEMENTED          → HOLD `GRPC_UNAVAILABLE`  (service healthy — no failure)
   */
  async runPipeline(
    instrument: string,
    timeframe: Timeframe,
    barTs: Date,
  ): Promise<RunPipelineOutcome> {
    if (!this.breaker.canAttempt()) {
      return {
        kind: 'hold',
        reason: 'CIRCUIT_OPEN',
        detail: `breaker ${this.breaker.state()} — call not attempted`,
      };
    }

    const protoTimeframe = TIMEFRAME_TO_PROTO[timeframe];
    if (protoTimeframe === undefined) {
      // Config error, not a service failure — don't poison the breaker.
      return { kind: 'hold', reason: 'GATE_SKIP', detail: `unsupported timeframe ${timeframe}` };
    }

    let res: Record<string, unknown>;
    try {
      res = await new Promise((resolvePromise, rejectPromise) => {
        this.stub.RunPipeline(
          {
            instrument,
            timeframe: protoTimeframe,
            barTs: {
              seconds: Math.floor(barTs.getTime() / 1000),
              nanos: (barTs.getTime() % 1000) * 1e6,
            },
          },
          { deadline: Date.now() + this.timeoutMs },
          (err, value) => (err ? rejectPromise(err) : resolvePromise(value)),
        );
      });
    } catch (err) {
      return this.mapError(err);
    }

    this.breaker.recordSuccess();
    return { kind: 'result', result: mapResponse(res) };
  }

  private mapError(err: unknown): RunPipelineOutcome {
    const code = (err as grpc.ServiceError)?.code;
    const detail = err instanceof Error ? err.message : String(err);

    // Service answered deterministically — healthy transport, policy HOLDs.
    if (code === grpc.status.FAILED_PRECONDITION) {
      this.breaker.recordSuccess();
      return { kind: 'hold', reason: 'NO_CHAMPION', detail };
    }
    if (code === grpc.status.UNIMPLEMENTED) {
      this.breaker.recordSuccess();
      return { kind: 'hold', reason: 'GRPC_UNAVAILABLE', detail };
    }

    // Slow or unreachable — these count toward opening the circuit.
    this.breaker.recordFailure();
    if (code === grpc.status.DEADLINE_EXCEEDED) {
      return { kind: 'hold', reason: 'GRPC_TIMEOUT', detail };
    }
    return { kind: 'hold', reason: 'GRPC_UNAVAILABLE', detail };
  }
}

function mapResponse(res: Record<string, unknown>): PipelineResult {
  const rawCandidate = res.candidate as Record<string, unknown> | undefined;
  const hasCandidate = Boolean(res.hasCandidate);
  const candidate: QuantCandidate | null =
    hasCandidate && rawCandidate
      ? {
          instrument: rawCandidate.instrument as string,
          side: PROTO_TO_SIDE[rawCandidate.side as number] ?? 'long',
          probability: rawCandidate.probability as number,
          regime: rawCandidate.regime as string,
          modelVersion: rawCandidate.modelVersion as string,
          entryPrice: rawCandidate.entryPrice as number,
          stopLossPrice: rawCandidate.stopLossPrice as number,
          takeProfitPrice: rawCandidate.takeProfitPrice as number,
        }
      : null;
  return {
    features: (res.features as Record<string, number>) ?? {},
    hasCandidate,
    candidate,
    sessionLabel: (res.sessionLabel as string) ?? '',
    liquidityRegime: (res.liquidityRegime as string) ?? '',
    trendRegime: (res.trendRegime as string) ?? '',
    regimeEntropy: (res.regimeEntropy as number) ?? 0,
    debateRounds: (res.debateRounds as number) ?? 0,
    featureSetVersion: (res.featureSetVersion as number) ?? 0,
    challengerProbability: (res.challengerProbability as number | undefined) ?? null,
  };
}
