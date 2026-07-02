import { z } from 'zod';

/**
 * FE-006 — typed session shared by dashboard and auth-client.
 * `stepUp2FAAt`: last successful TOTP step-up; stale after 15 min for sensitive ops.
 */
export const FXSessionSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullish(),
    image: z.url().nullish(),
  }),
  stepUp2FAAt: z.iso.datetime().nullable(),
  expires: z.iso.datetime(),
});
export type FXSession = z.infer<typeof FXSessionSchema>;

/** Step-up freshness window for sensitive actions (kill-switch, mode change). */
export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000;
