/** Shared in-memory fakes for the Step-2.2 worker tests (BE-050/051/052).
 * Test-only module — not imported by any runtime entrypoint. */

import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import type {
  BrokerPosition,
  BrokerTransaction,
  CloseTradeResult,
  PlaceOrderResult,
  QuantExecutionClient,
} from './quant-client.js';

// ── prisma ──────────────────────────────────────────────────────────────────

export interface FakeIntent {
  id: string;
  signalId?: string;
  instrument: string;
  side: 'long' | 'short';
  units: number;
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number | null;
  riskPct?: number;
  status: string;
  reasonCode?: string | null;
  tradingMode: 'backtest' | 'paper' | 'live';
  decidedAt?: Date | null;
}

export interface FakeTrade {
  id: string;
  intentId?: string | null;
  instrument: string;
  side: 'long' | 'short';
  units: number;
  entryPrice: number;
  exitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  brokerTradeId?: string | null;
  brokerOrderId?: string | null;
  realizedPnl?: number | null;
  swapPnl?: number;
  commission?: number;
  status: 'open' | 'closed' | 'cancelled';
  tradingMode: 'backtest' | 'paper' | 'live';
  openedAt?: Date;
  closedAt?: Date | null;
  meta?: Record<string, unknown> | null;
}

export interface FakeDb {
  intents: Map<string, FakeIntent>;
  trades: Map<string, FakeTrade>;
  audits: Record<string, unknown>[];
  ticks: Map<string, { bid: number; ask: number }>;
}

export function makeDb(): FakeDb {
  return { intents: new Map(), trades: new Map(), audits: [], ticks: new Map() };
}

let seq = 0;
const nextId = () => `fake-${++seq}`;

export function fakePrisma(db: FakeDb): PrismaClient {
  const prisma = {
    tradeIntent: {
      findUnique: async ({ where }: { where: { id: string } }) => db.intents.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeIntent> }) => {
        const row = db.intents.get(where.id);
        if (!row) throw new Error(`intent ${where.id} not found`);
        Object.assign(row, data);
        return row;
      },
    },
    trade: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { intentId: string };
        create: Omit<FakeTrade, 'id'>;
        update: Partial<FakeTrade>;
      }) => {
        const existing = [...db.trades.values()].find((t) => t.intentId === where.intentId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: FakeTrade = { id: nextId(), ...create };
        db.trades.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeTrade> }) => {
        const row = db.trades.get(where.id);
        if (!row) throw new Error(`trade ${where.id} not found`);
        Object.assign(row, data);
        return row;
      },
      findFirst: async ({ where }: { where: { brokerTradeId?: string; status?: string } }) =>
        [...db.trades.values()].find(
          (t) =>
            (where.brokerTradeId === undefined || t.brokerTradeId === where.brokerTradeId) &&
            (where.status === undefined || t.status === where.status),
        ) ?? null,
      findMany: async ({ where }: { where: { status?: string } }) =>
        [...db.trades.values()].filter(
          (t) => where.status === undefined || t.status === where.status,
        ),
    },
    tick: {
      findFirst: async ({ where }: { where: { instrument: string } }) =>
        db.ticks.get(where.instrument) ?? null,
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.audits.push(data);
        return data;
      },
    },
  };
  return prisma as unknown as PrismaClient;
}

// ── redis ───────────────────────────────────────────────────────────────────

export interface FakeRedisRig {
  redis: Redis;
  store: Map<string, string>;
  published: { channel: string; message: string }[];
}

export function fakeRedis(): FakeRedisRig {
  const store = new Map<string, string>();
  const published: { channel: string; message: string }[] = [];
  const redis = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string | number) => {
      store.set(k, String(v));
      return 'OK';
    },
    del: async (...keys: string[]) => keys.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    },
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      return 0;
    },
  };
  return { redis: redis as unknown as Redis, store, published };
}

/** WS events fanned out via Redis (`ws:fanout`), parsed back to {channel, payload}. */
export function wsEvents(rig: FakeRedisRig): { channel: string; payload: unknown }[] {
  return rig.published
    .filter((p) => p.channel === 'ws:fanout')
    .map((p) => JSON.parse(p.message) as { channel: string; payload: unknown });
}

// ── queues ──────────────────────────────────────────────────────────────────

export interface FakeQueueRig<T = unknown> {
  queue: Queue<T>;
  jobs: { name: string; data: T }[];
}

export function fakeQueue<T = unknown>(): FakeQueueRig<T> {
  const jobs: { name: string; data: T }[] = [];
  const queue = {
    add: async (name: string, data: T) => {
      jobs.push({ name, data });
      return { id: String(jobs.length) };
    },
  };
  return { queue: queue as unknown as Queue<T>, jobs };
}

// ── quant client ────────────────────────────────────────────────────────────

export interface FakeQuantBehavior {
  placeOrder?: (params: unknown) => Promise<PlaceOrderResult> | PlaceOrderResult;
  closeTrade?: (brokerTradeId: string, units?: number) => CloseTradeResult;
  modifyTradeOk?: boolean | (() => boolean);
  positions?: BrokerPosition[];
  transactions?: BrokerTransaction[];
  lastTxnId?: string;
}

export interface FakeQuantRig {
  quant: QuantExecutionClient;
  calls: { method: string; args: unknown[] }[];
}

export function filledOrder(over: Partial<PlaceOrderResult> = {}): PlaceOrderResult {
  return {
    status: 'FILLED',
    broker: 'oanda',
    brokerOrderId: 'o-1',
    brokerTradeId: 'bt-1',
    requestedUnits: 10_000,
    filledUnits: 10_000,
    remainderUnits: 0,
    fillPrice: 1.1,
    reasonCode: null,
    ...over,
  };
}

export function fakeQuant(behavior: FakeQuantBehavior = {}): FakeQuantRig {
  const calls: { method: string; args: unknown[] }[] = [];
  const quant = {
    placeOrder: async (params: unknown) => {
      calls.push({ method: 'placeOrder', args: [params] });
      return behavior.placeOrder ? behavior.placeOrder(params) : filledOrder();
    },
    closeTrade: async (brokerTradeId: string, units?: number) => {
      calls.push({ method: 'closeTrade', args: [brokerTradeId, units] });
      return (
        behavior.closeTrade?.(brokerTradeId, units) ?? {
          status: 'FILLED' as const,
          brokerOrderId: 'o-c',
          filledUnits: units ?? 0,
          fillPrice: 1.12,
          reasonCode: null,
        }
      );
    },
    modifyTrade: async (brokerTradeId: string, opts: unknown) => {
      calls.push({ method: 'modifyTrade', args: [brokerTradeId, opts] });
      const ok =
        typeof behavior.modifyTradeOk === 'function'
          ? behavior.modifyTradeOk()
          : (behavior.modifyTradeOk ?? true);
      return { ok, reasonCode: ok ? null : 'REJECTED' };
    },
    listOpenPositions: async () => {
      calls.push({ method: 'listOpenPositions', args: [] });
      return behavior.positions ?? [];
    },
    getTransactions: async (sinceTxnId?: string) => {
      calls.push({ method: 'getTransactions', args: [sinceTxnId] });
      return {
        transactions: behavior.transactions ?? [],
        lastTxnId: behavior.lastTxnId ?? '',
      };
    },
  };
  return { quant: quant as unknown as QuantExecutionClient, calls };
}

/** Minimal BrokerTransaction with sane defaults. */
export function txn(over: Partial<BrokerTransaction> = {}): BrokerTransaction {
  return {
    id: '2001',
    type: 'ORDER_FILL',
    reason: 'MARKET_ORDER',
    instrument: 'EUR_USD',
    tradeId: null,
    units: 10_000,
    price: 1.1,
    pl: 0,
    financing: 0,
    commission: 0,
    clientOrderId: '',
    tradeOpenedId: null,
    tradesClosed: [],
    tradeReduced: null,
    time: new Date().toISOString(),
    ...over,
  };
}

// ── env ─────────────────────────────────────────────────────────────────────

export function fakeEnv(over: Record<string, unknown> = {}): Env {
  return {
    TRADING_MODE: 'paper',
    RECONCILE_ACTION: 'halt',
    TRADE_MANAGER_PARTIAL_TRIGGER_R: 1,
    TRADE_MANAGER_PARTIAL_FRACTION: 0.5,
    TRADE_MANAGER_BREAKEVEN_BUFFER_R: 0.05,
    TRADE_MANAGER_TRAIL_DISTANCE_R: 0.5,
    ...over,
  } as unknown as Env;
}
