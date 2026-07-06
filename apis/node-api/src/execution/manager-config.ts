import { z } from 'zod';
import type { Env } from '../env.js';

/**
 * BE-051 — trade manager config (env-overridable defaults).
 * +1R partial close, breakeven buffer, trailing distance.
 */
const ManagerConfigSchema = z.object({
  /** R-multiple trigger for partial + breakeven (default +1R). */
  partialTriggerR: z.coerce.number().positive().default(1),
  /** Fraction of position to close at trigger (default 50%). */
  partialFraction: z.coerce.number().gt(0).lte(1).default(0.5),
  /** Breakeven SL buffer as fraction of original risk distance. */
  breakevenBufferR: z.coerce.number().nonnegative().default(0.05),
  /** Trailing SL distance as fraction of original risk distance. */
  trailDistanceR: z.coerce.number().positive().default(0.5),
});

export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;

export function loadManagerConfig(env: Env): ManagerConfig {
  return ManagerConfigSchema.parse({
    partialTriggerR: env.TRADE_MANAGER_PARTIAL_TRIGGER_R,
    partialFraction: env.TRADE_MANAGER_PARTIAL_FRACTION,
    breakevenBufferR: env.TRADE_MANAGER_BREAKEVEN_BUFFER_R,
    trailDistanceR: env.TRADE_MANAGER_TRAIL_DISTANCE_R,
  });
}
