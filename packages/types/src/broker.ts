import { z } from 'zod';
import { InstrumentSchema } from './trading.js';

/**
 * QN-030 — BrokerAdapter contract: the cross-language shape of orders, fills,
 * positions, and history shared by every execution adapter and, in Phase 2.2,
 * the Node order-lifecycle worker (BE-050…054). OANDA (QN-032) is the sole
 * venue (ADR-005; the optional MT5 adapter QN-031 was dropped 2026-07-06) —
 * the enum stays so a future venue is an enum value, not a schema change.
 *
 * Source of truth is Zod here; Python runtime models
 * (`services/quant/app/execution/models.py`) mirror these fields and the
 * conformance suite (`tests/execution/test_conformance.py`) pins adapters to
 * the contract. Emitted to JSON Schema via `contractSchemas` (index.ts).
 */

export const BrokerSchema = z.enum(['oanda']);
export type Broker = z.infer<typeof BrokerSchema>;

export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

/** Market order request. `clientOrderId` is the cross-broker idempotency key. */
export const OrderRequestSchema = z.object({
  /** UUID minted by the caller; retries MUST reuse it (idempotency). */
  clientOrderId: z.string().min(1),
  instrument: InstrumentSchema,
  side: OrderSideSchema,
  /** Base-currency units (OANDA convention); always positive — side carries direction. */
  units: z.number().positive(),
  type: z.literal('market').default('market'),
  /** Optional protective prices attached at fill time. */
  stopLossPrice: z.number().positive().nullish(),
  takeProfitPrice: z.number().positive().nullish(),
});
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export const OrderStatusSchema = z.enum(['filled', 'partial', 'rejected']);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Outcome of place/close. `partial` carries the unfilled remainder (QN-032 AC). */
export const OrderResultSchema = z.object({
  clientOrderId: z.string(),
  status: OrderStatusSchema,
  broker: BrokerSchema,
  brokerOrderId: z.string().nullable(),
  /** Set on (partial) fills — the id used to close/track the position. */
  brokerTradeId: z.string().nullable(),
  requestedUnits: z.number(),
  filledUnits: z.number(),
  /** requestedUnits − filledUnits; >0 only when status = partial. */
  remainderUnits: z.number(),
  /** Average fill price; null when rejected. */
  price: z.number().nullable(),
  /** Broker reject/cancel reason; null on success. */
  reason: z.string().nullable(),
});
export type OrderResult = z.infer<typeof OrderResultSchema>;

export const BrokerPositionSchema = z.object({
  instrument: InstrumentSchema,
  side: OrderSideSchema,
  units: z.number().positive(),
  avgPrice: z.number(),
  unrealizedPl: z.number(),
  brokerTradeIds: z.array(z.string()),
});
export type BrokerPosition = z.infer<typeof BrokerPositionSchema>;

/** A closed trade returned by get_history. */
export const BrokerTradeRecordSchema = z.object({
  brokerTradeId: z.string(),
  instrument: InstrumentSchema,
  side: OrderSideSchema,
  units: z.number().positive(),
  openPrice: z.number(),
  closePrice: z.number().nullable(),
  realizedPl: z.number(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type BrokerTradeRecord = z.infer<typeof BrokerTradeRecordSchema>;
