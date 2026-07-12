import { z } from 'zod';

/**
 * BE-072/073 — master kill-switch API contracts (`/settings/kill-switch`).
 *
 * The FE-011 `<KillSwitchButton>` contract is unchanged: `onConfirm` passes
 * an optional `twoFactorCode` which maps straight onto the request body.
 * Step-up 2FA enforcement activates when BE-036 lands (Phase 5) — the shape
 * is fixed now so nothing changes then.
 */

export const KillSwitchActionSchema = z.enum(['activate', 'deactivate']);
export type KillSwitchAction = z.infer<typeof KillSwitchActionSchema>;

export const KillSwitchRequestSchema = z.object({
  action: KillSwitchActionSchema,
  /** Required free-text reason on activate (audit trail). */
  reason: z.string().min(1).max(500).optional(),
  /** Step-up 2FA code (verified once BE-036 lands; accepted-and-noted before). */
  twoFactorCode: z.string().optional(),
});
export type KillSwitchRequest = z.infer<typeof KillSwitchRequestSchema>;

/** ADR-012: reported status is CLOSING (never CLOSED) until broker-confirmed flat. */
export const KillSwitchCloseOutStatusSchema = z.enum(['closing', 'flat', 'failed']);

export const KillSwitchCloseAttemptSchema = z.object({
  brokerTradeId: z.string(),
  instrument: z.string(),
  attempts: z.number().int().min(0),
  status: z.enum(['closed', 'failed']),
  lastError: z.string().nullable(),
});

export const KillSwitchCloseOutReportSchema = z.object({
  pendingIntentsCancelled: z.number().int().min(0),
  positionsSeen: z.number().int().min(0),
  closes: z.array(KillSwitchCloseAttemptSchema),
  brokerConfirmedFlat: z.boolean(),
  status: KillSwitchCloseOutStatusSchema,
  elapsedMs: z.number().min(0),
});
export type KillSwitchCloseOutReport = z.infer<typeof KillSwitchCloseOutReportSchema>;

export const KillSwitchStateSchema = z.object({
  active: z.boolean(),
  reason: z.string().nullable(),
  activatedBy: z.string().nullable(),
  activatedAt: z.iso.datetime().nullable(),
  deactivatedAt: z.iso.datetime().nullable(),
  closeOutStatus: KillSwitchCloseOutStatusSchema.nullable(),
});
export type KillSwitchState = z.infer<typeof KillSwitchStateSchema>;

export const KillSwitchResponseSchema = z.object({
  state: KillSwitchStateSchema,
  /** Present on activate responses only. */
  closeOut: KillSwitchCloseOutReportSchema.nullable(),
  /** Wall-clock ms from request receipt to response (the <2s AC measure). */
  elapsedMs: z.number().min(0),
});
export type KillSwitchResponse = z.infer<typeof KillSwitchResponseSchema>;
