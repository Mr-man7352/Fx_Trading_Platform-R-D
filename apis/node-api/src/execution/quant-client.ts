import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Env } from '../env.js';

/** BE-050 — gRPC ExecutionService client (Node → Python quant). */

export type ExecutionStatus = 'FILLED' | 'PARTIAL' | 'REJECTED' | 'UNSPECIFIED';

export interface PlaceOrderParams {
  clientOrderId: string;
  instrument: string;
  side: 'long' | 'short';
  units: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface PlaceOrderResult {
  status: ExecutionStatus;
  broker: string;
  brokerOrderId: string | null;
  brokerTradeId: string | null;
  requestedUnits: number;
  filledUnits: number;
  remainderUnits: number;
  fillPrice: number | null;
  reasonCode: string | null;
}

export interface CloseTradeResult {
  status: ExecutionStatus;
  brokerOrderId: string | null;
  filledUnits: number;
  fillPrice: number | null;
  reasonCode: string | null;
}

export interface BrokerPosition {
  instrument: string;
  side: 'long' | 'short';
  units: number;
  avgPrice: number;
  unrealizedPl: number;
  brokerTradeIds: string[];
}

/** OANDA TradeReduce — per-trade close/reduce detail inside an ORDER_FILL. */
export interface TradeReduce {
  tradeId: string;
  units: number;
  price: number | null;
  realizedPl: number;
  financing: number;
}

export interface BrokerTransaction {
  id: string;
  type: string;
  /** ORDER_FILL reason: MARKET_ORDER, STOP_LOSS_ORDER, TAKE_PROFIT_ORDER, … */
  reason: string;
  instrument: string;
  /** Top-level tradeID (SL/TP order txns — NEVER set on fills). */
  tradeId: string | null;
  units: number | null;
  price: number | null;
  pl: number | null;
  financing: number | null;
  commission: number | null;
  clientOrderId: string;
  /** ORDER_FILL tradeOpened.tradeID — the trade this fill opened. */
  tradeOpenedId: string | null;
  /** Trades FULLY closed by this fill. */
  tradesClosed: TradeReduce[];
  /** Trade PARTIALLY closed by this fill. */
  tradeReduced: TradeReduce | null;
  time: string;
}

function mapTradeReduce(raw: Record<string, unknown>): TradeReduce {
  return {
    tradeId: raw.tradeId as string,
    units: (raw.units as number) ?? 0,
    price: (raw.price as number) || null,
    realizedPl: (raw.realizedPl as number) ?? 0,
    financing: (raw.financing as number) ?? 0,
  };
}

const STATUS_MAP: Record<number, ExecutionStatus> = {
  0: 'UNSPECIFIED',
  1: 'FILLED',
  2: 'PARTIAL',
  3: 'REJECTED',
};

const SIDE_TO_PROTO: Record<'long' | 'short', number> = { long: 1, short: 2 };
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

type ExecutionStub = {
  PlaceOrder: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  CloseTrade: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  ModifyTrade: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  ListOpenPositions: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  GetTransactions: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
};

function promisify<T>(
  fn: (
    req: Record<string, unknown>,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: T) => void,
  ) => void,
  req: Record<string, unknown>,
  deadlineMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(req, { deadline: Date.now() + deadlineMs }, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

export class QuantExecutionClient {
  private readonly stub: ExecutionStub;
  private readonly writeDeadlineMs: number;
  private readonly readDeadlineMs: number;

  constructor(env: Env, stub?: ExecutionStub) {
    this.writeDeadlineMs = env.QUANT_GRPC_WRITE_TIMEOUT_MS;
    this.readDeadlineMs = env.QUANT_GRPC_READ_TIMEOUT_MS;
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
            ExecutionService: new (addr: string, creds: grpc.ChannelCredentials) => ExecutionStub;
          };
        };
      };
    };
    this.stub = new pkg.fx.quant.v1.ExecutionService(
      env.QUANT_GRPC_URL,
      grpc.credentials.createInsecure(),
    );
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    const res = await promisify(
      this.stub.PlaceOrder.bind(this.stub),
      {
        clientOrderId: params.clientOrderId,
        instrument: params.instrument,
        side: SIDE_TO_PROTO[params.side],
        units: params.units,
        stopLossPrice: params.stopLossPrice,
        takeProfitPrice: params.takeProfitPrice,
      },
      this.writeDeadlineMs,
    );
    return this.mapPlaceResult(res);
  }

  async closeTrade(brokerTradeId: string, units?: number): Promise<CloseTradeResult> {
    const res = await promisify(
      this.stub.CloseTrade.bind(this.stub),
      { brokerTradeId, units: units ?? 0 },
      this.writeDeadlineMs,
    );
    return {
      status: STATUS_MAP[res.status as number] ?? 'UNSPECIFIED',
      brokerOrderId: (res.brokerOrderId as string) || null,
      filledUnits: res.filledUnits as number,
      fillPrice: (res.fillPrice as number) || null,
      reasonCode: (res.reasonCode as string) || null,
    };
  }

  async modifyTrade(
    brokerTradeId: string,
    opts: { stopLossPrice?: number; takeProfitPrice?: number },
  ): Promise<{ ok: boolean; reasonCode: string | null }> {
    const res = await promisify(
      this.stub.ModifyTrade.bind(this.stub),
      {
        brokerTradeId,
        stopLossPrice: opts.stopLossPrice,
        takeProfitPrice: opts.takeProfitPrice,
      },
      this.writeDeadlineMs,
    );
    return {
      ok: res.status === 1,
      reasonCode: (res.reasonCode as string) || null,
    };
  }

  async listOpenPositions(): Promise<BrokerPosition[]> {
    const res = await promisify(
      this.stub.ListOpenPositions.bind(this.stub),
      {},
      this.readDeadlineMs,
    );
    const positions = (res.positions as Record<string, unknown>[]) ?? [];
    return positions.map((p) => ({
      instrument: p.instrument as string,
      side: PROTO_TO_SIDE[p.side as number] ?? 'long',
      units: p.units as number,
      avgPrice: p.avgPrice as number,
      unrealizedPl: p.unrealizedPl as number,
      brokerTradeIds: (p.brokerTradeIds as string[]) ?? [],
    }));
  }

  async getTransactions(
    sinceTxnId?: string,
  ): Promise<{ transactions: BrokerTransaction[]; lastTxnId: string }> {
    const res = await promisify(
      this.stub.GetTransactions.bind(this.stub),
      { sinceTxnId: sinceTxnId ?? '' },
      this.readDeadlineMs,
    );
    const txs = (res.transactions as Record<string, unknown>[]) ?? [];
    return {
      transactions: txs.map((tx) => ({
        id: tx.id as string,
        type: tx.type as string,
        reason: (tx.reason as string) ?? '',
        instrument: tx.instrument as string,
        tradeId: (tx.tradeId as string) || null,
        units: (tx.units as number) || null,
        price: (tx.price as number) || null,
        pl: (tx.pl as number) || null,
        financing: (tx.financing as number) || null,
        commission: (tx.commission as number) || null,
        clientOrderId: tx.clientOrderId as string,
        tradeOpenedId: (tx.tradeOpenedId as string) || null,
        tradesClosed: ((tx.tradesClosed as Record<string, unknown>[]) ?? []).map(mapTradeReduce),
        tradeReduced: tx.tradeReduced
          ? mapTradeReduce(tx.tradeReduced as Record<string, unknown>)
          : null,
        time: tx.time
          ? new Date(Number((tx.time as { seconds: unknown }).seconds ?? 0) * 1000).toISOString()
          : new Date().toISOString(),
      })),
      lastTxnId: (res.lastTxnId as string) ?? '',
    };
  }

  private mapPlaceResult(res: Record<string, unknown>): PlaceOrderResult {
    return {
      status: STATUS_MAP[res.status as number] ?? 'UNSPECIFIED',
      broker: res.broker as string,
      brokerOrderId: (res.brokerOrderId as string) || null,
      brokerTradeId: (res.brokerTradeId as string) || null,
      requestedUnits: res.requestedUnits as number,
      filledUnits: res.filledUnits as number,
      remainderUnits: res.remainderUnits as number,
      fillPrice: (res.fillPrice as number) || null,
      reasonCode: (res.reasonCode as string) || null,
    };
  }
}

/** True when gRPC failed after send — outcome unknown (BE-050). */
export function isUnknownOutcome(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as grpc.ServiceError).code;
  return (
    code === grpc.status.DEADLINE_EXCEEDED ||
    code === grpc.status.UNAVAILABLE ||
    code === grpc.status.UNKNOWN
  );
}
