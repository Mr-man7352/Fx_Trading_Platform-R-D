import { z } from 'zod';
import { TradingModeSchema } from './trading.js';

/**
 * BE-130 — append-only audit log contracts (`GET /audit`).
 * `id` is the DB bigint serialized as a string (JSON-safe).
 */
export const AuditLogEntrySchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  requestId: z.string(),
  actorId: z.string().nullable(),
  role: z.string(),
  method: z.string(),
  url: z.string(),
  statusCode: z.number().int(),
  tradingMode: TradingModeSchema,
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  actorId: z.string().optional(),
  method: z.string().optional(),
  /** ISO timestamp lower bound (inclusive). */
  from: z.iso.datetime().optional(),
  /** ISO timestamp upper bound (exclusive). */
  to: z.iso.datetime().optional(),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogPageSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;
