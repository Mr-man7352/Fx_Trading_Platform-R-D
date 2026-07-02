import { z } from 'zod';
import { TradingModeSchema } from './trading.js';

/** BE-010 — `GET /healthz` contract. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  commit: z.string(),
  uptime: z.number(),
  tradingMode: TradingModeSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** BE-011 — consistent JSON error shape with requestId. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** FE-005 — 403 code that must open the step-up 2FA modal. */
export const STEP_UP_2FA_REQUIRED = 'STEP_UP_2FA_REQUIRED' as const;
