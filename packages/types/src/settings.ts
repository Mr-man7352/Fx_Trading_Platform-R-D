import { z } from 'zod';

/**
 * BE-100/BE-101 — operator settings + live-promotion contracts (Step 5.3).
 * Node-internal (dashboard ↔ node-api), like killswitch.ts: exported from the
 * package but NOT registered in `contractSchemas` (Python never consumes them;
 * registering would churn the QN-003 codegen drift check).
 *
 * The FE-100 client-side range checks mirror these bounds — THIS schema is the
 * authoritative contract; the server re-validates every PATCH against it.
 */

// ── Risk / agent knobs (v2.2 machinery — FE-100) ─────────────────────────────

export const RiskSettingsSchema = z.object({
  /** QN-048 — correlation clustering lookback window (days). */
  clusterLookbackDays: z.number().int().min(5).max(365).default(60),
  /** QN-048 — |ρ| threshold for cluster membership. */
  clusterThreshold: z.number().min(0).max(1).default(0.6),
  /** QN-048 — scheduled refresh cadence (hours; event triggers still fire). */
  clusterCadenceHours: z.number().int().min(1).max(168).default(24),
  /** Session spread multipliers (risk-gate spread rule scaling). */
  sessionMultLondon: z.number().min(0.1).max(5).default(1),
  sessionMultNewYork: z.number().min(0.1).max(5).default(1),
  sessionMultTokyo: z.number().min(0.1).max(5).default(0.8),
  /** Weekend-gap flatten arming (risk-gate weekend rule). */
  weekendGapFlatten: z.boolean().default(true),
  /** BE-070 — per-instrument daily loss tripwire (fraction of equity). */
  perInstrumentDailyLossPct: z.number().min(0.001).max(0.1).default(0.02),
  /** BE-062 — configured debate rounds by regime entropy band (§9.6). */
  debateRoundsLowEntropy: z.number().int().min(0).max(2).default(0),
  debateRoundsHighEntropy: z.number().int().min(0).max(2).default(2),
  /** ADR-010 — entry-gate pre-filter P (graph never fires below it). */
  entryGatePreFilter: z.number().min(0.5).max(0.95).default(0.5),
});
export type RiskSettings = z.infer<typeof RiskSettingsSchema>;

/** Effective platform settings document (extensible: risk today, more later). */
export const PlatformSettingsSchema = z.object({
  risk: RiskSettingsSchema.default(RiskSettingsSchema.parse({})),
});
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = PlatformSettingsSchema.parse({});

/** PATCH /settings body — partial overlay, merged over the stored document. */
export const SettingsPatchSchema = z.object({
  risk: RiskSettingsSchema.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const SettingsResponseSchema = z.object({
  /** Monotonic version (append-only platform_settings; 0 = defaults only). */
  version: z.number().int().min(0),
  settings: PlatformSettingsSchema,
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

// ── Broker credentials write path (BE-100 + BE-131; step-up 2FA required) ────

export const BrokerCredentialsWriteSchema = z.object({
  broker: z.enum(['oanda', 'mt5']).default('oanda'),
  environment: z.enum(['practice', 'live']).default('practice'),
  label: z.string().min(1).max(50).default('default'),
  /** OANDA v20 personal access token — sealed at rest, never echoed back. */
  apiToken: z.string().min(10),
  /** OANDA account id, e.g. "101-004-1234567-001". */
  accountId: z.string().min(5),
});
export type BrokerCredentialsWrite = z.infer<typeof BrokerCredentialsWriteSchema>;

export const BrokerCredentialsWriteResponseSchema = z.object({
  id: z.string(),
  broker: z.string(),
  environment: z.string(),
  label: z.string(),
  /** First 4 + last 4 chars only (BE-131 — never returned in full). */
  tokenPreview: z.string(),
  updatedAt: z.iso.datetime(),
});
export type BrokerCredentialsWriteResponse = z.infer<typeof BrokerCredentialsWriteResponseSchema>;

// ── Live-promotion gate (BE-101) ─────────────────────────────────────────────

export const LivePromotionCheckIdSchema = z.enum([
  'step_up_2fa',
  'champion_model',
  'model_validated',
  'paper_window_90d',
  'signed_risk_report',
  'kill_switch_inactive',
]);
export type LivePromotionCheckId = z.infer<typeof LivePromotionCheckIdSchema>;

export const LivePromotionCheckSchema = z.object({
  id: LivePromotionCheckIdSchema,
  label: z.string(),
  ok: z.boolean(),
  /** Human-readable evidence or what's missing. */
  detail: z.string().nullable(),
});
export type LivePromotionCheck = z.infer<typeof LivePromotionCheckSchema>;

export const LivePromotionResponseSchema = z.object({
  allowed: z.boolean(),
  checklist: z.array(LivePromotionCheckSchema),
  /**
   * TRADING_MODE stays an env flag (BE-003 — one code path, set at deploy).
   * When `allowed`, POST records a signed-off promotion approval in the audit
   * log; the actual flip to `live` is the documented deploy step.
   */
  note: z.string(),
});
export type LivePromotionResponse = z.infer<typeof LivePromotionResponseSchema>;
