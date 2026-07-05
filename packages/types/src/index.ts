import { ApiErrorSchema, HealthResponseSchema } from './api.js';
import { AuditLogEntrySchema, AuditLogPageSchema, AuditLogQuerySchema } from './audit.js';
import { FXSessionSchema } from './auth.js';
import {
  InstrumentSchema,
  TradeSchema,
  TradeSideSchema,
  TradesListResponseSchema,
  TradingModeSchema,
} from './trading.js';
import { WsClientMessageSchema, WsServerMessageSchema } from './ws.js';

export * from './api.js';
export * from './audit.js';
export * from './auth.js';
export * from './market.js';
export * from './trading.js';
export * from './ws.js';

/**
 * Registry of contract schemas emitted as JSON Schema to `dist/schemas/`
 * (consumed by Python via datamodel-code-generator — QN-003).
 * Every cross-service contract MUST be registered here.
 */
export const contractSchemas = {
  TradingMode: TradingModeSchema,
  Instrument: InstrumentSchema,
  TradeSide: TradeSideSchema,
  Trade: TradeSchema,
  TradesListResponse: TradesListResponseSchema,
  HealthResponse: HealthResponseSchema,
  ApiError: ApiErrorSchema,
  FXSession: FXSessionSchema,
  WsClientMessage: WsClientMessageSchema,
  WsServerMessage: WsServerMessageSchema,
  AuditLogEntry: AuditLogEntrySchema,
  AuditLogQuery: AuditLogQuerySchema,
  AuditLogPage: AuditLogPageSchema,
} as const;
