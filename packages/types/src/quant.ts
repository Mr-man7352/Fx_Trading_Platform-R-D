import { z } from 'zod';

/**
 * QN-055 (via the Node proxy, FE-090) — quant analytics read contracts.
 * Node-internal, NOT in `contractSchemas` (Python OWNS these responses; these
 * schemas only validate what the dashboard consumes and stay deliberately
 * tolerant of extra fields — `loose` — so the quant service can evolve).
 */

export const QuantCalibrationResponseSchema = z.looseObject({
  instrument: z.string(),
  timeframe: z.string(),
  version: z.number().int(),
  role: z.string(),
  calibration_method: z.string(),
  /** Reliability curve: [predicted_bucket_mean, observed_frequency][] or richer. */
  curve: z.unknown(),
  metrics: z.record(z.string(), z.unknown()).nullish(),
  trained_at: z.string(),
});
export type QuantCalibrationResponse = z.infer<typeof QuantCalibrationResponseSchema>;

export const QuantModelEntrySchema = z.looseObject({
  instrument: z.string(),
  timeframe: z.string(),
  version: z.number().int(),
  role: z.string(),
  calibrationMethod: z.string(),
  trainedAt: z.string(),
  promotedAt: z.string().nullable(),
  metrics: z.unknown().nullable(),
});
export type QuantModelEntry = z.infer<typeof QuantModelEntrySchema>;

export const QuantModelsResponseSchema = z.object({
  models: z.array(QuantModelEntrySchema),
});
export type QuantModelsResponse = z.infer<typeof QuantModelsResponseSchema>;

export const QuantRegimePointSchema = z.looseObject({
  ts: z.string(),
  regime: z.string(),
});

export const QuantRegimeResponseSchema = z.looseObject({
  instrument: z.string(),
  timeframe: z.string(),
  current: z.string(),
  entropy: z.number().nullable(),
  debate_rounds: z.number().int(),
  timeline: z.array(QuantRegimePointSchema),
});
export type QuantRegimeResponse = z.infer<typeof QuantRegimeResponseSchema>;
