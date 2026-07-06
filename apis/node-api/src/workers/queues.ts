/**
 * Step 1.6 / Step 2.2 — shared queue names + job payloads.
 */
export const MARKET_TICKS_QUEUE = 'market-ticks';
export const SIGNALS_QUEUE = 'signals';
/** BE-050 — order placement jobs (producer: enqueue-intent script, later signals worker). */
export const EXECUTION_QUEUE = 'execution';
/** BE-051 — trade manager repeatable tick (30s). */
export const TRADE_MANAGER_QUEUE = 'trade-manager';
/** BE-052 — broker ↔ DB reconciler (60s). */
export const RECONCILIATION_QUEUE = 'reconciliation';
/** BE-050 — Phase-3 LLM supervision (producer only in Step 2.2). */
export const SUPERVISION_QUEUE = 'supervision';
/** BE-050 — minimal Telegram/log notification seam. */
export const NOTIFICATIONS_QUEUE = 'notifications';

/** Redis pub/sub: workers → API WS fan-out. */
export const WS_FANOUT_CHANNEL = 'ws:fanout';

/** Redis pub/sub channel the data-quality monitor publishes flags to. */
export const DATA_QUALITY_CHANNEL = 'data-quality:flags';

export interface TickJob {
  instrument: string;
  /** ISO-8601 tick time (UTC). */
  ts: string;
  bid: number;
  ask: number;
}

export interface SignalJob {
  instrument: string;
  timeframe: string;
  /** ISO-8601 bar-open time of the closed bar that triggered the signal. */
  barTs: string;
}

/** BE-050 — execute one approved TradeIntent. */
export interface ExecutionJob {
  intentId: string;
}

/** BE-050 — operator alert (Telegram when configured). */
export interface NotificationJob {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  event?: string;
}

/** BE-051 — Phase-3 supervision advisory (producer only). */
export interface SupervisionJob {
  tradeId: string;
}
