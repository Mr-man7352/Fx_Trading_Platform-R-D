import { z } from 'zod';

/**
 * BE-003 — single mode flag driving one identical code path everywhere.
 * `backtest | paper | live`. Live requires the promotion gate (BE-101/BE-122).
 */
export const TradingModeSchema = z.enum(['backtest', 'paper', 'live']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

/**
 * OANDA-style instrument name, e.g. EUR_USD, XAU_USD, BCO_USD, WTICO_USD.
 * Sides allow 2–6 chars to cover longer OANDA symbols (WTICO, and index CFDs
 * like NAS100/SPX500 if ever added).
 */
export const InstrumentSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,6}_[A-Z0-9]{2,6}$/, 'Expected OANDA-style instrument, e.g. EUR_USD');
export type Instrument = z.infer<typeof InstrumentSchema>;

export const TradeSideSchema = z.enum(['long', 'short']);
export type TradeSide = z.infer<typeof TradeSideSchema>;

/**
 * Draft trade shape — placeholder until BE-054 (trades REST) lands in Phase 2.
 * Kept minimal so FE-005 `apiClient.trades.list()` is typed end-to-end from day one.
 */
export const TradeSchema = z.object({
  id: z.string(),
  instrument: InstrumentSchema,
  side: TradeSideSchema,
  units: z.number(),
  mode: TradingModeSchema,
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const TradesListResponseSchema = z.object({
  trades: z.array(TradeSchema),
});
export type TradesListResponse = z.infer<typeof TradesListResponseSchema>;
