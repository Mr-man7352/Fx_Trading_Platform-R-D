import { z } from 'zod';

/**
 * BE-110 — economic calendar contracts (Step 5.3). Node-internal (dashboard ↔
 * node-api), NOT registered in `contractSchemas` (see index.ts note).
 *
 * The risk-gate blackout rule (±30 min around high-impact events, per
 * currency) and the supervision `pre_news_flatten` layer consume these events
 * via the `CalendarProvider` seam; FE-101 renders them.
 */

export const CalendarImpactSchema = z.enum(['high', 'medium', 'low']);
export type CalendarImpact = z.infer<typeof CalendarImpactSchema>;

export const EconomicCalendarEventSchema = z.object({
  id: z.string(),
  /** Scheduled release time (UTC). */
  ts: z.iso.datetime(),
  /** ISO currency code the event touches, e.g. "USD". */
  currency: z.string().min(3).max(3),
  impact: CalendarImpactSchema,
  title: z.string(),
  source: z.string(),
  forecast: z.string().nullable(),
  previous: z.string().nullable(),
  actual: z.string().nullable(),
});
export type EconomicCalendarEvent = z.infer<typeof EconomicCalendarEventSchema>;

export const CalendarQuerySchema = z.object({
  /** ISO timestamp lower bound (inclusive). Default: now − 12 h. */
  from: z.iso.datetime().optional(),
  /** ISO timestamp upper bound (exclusive). Default: now + 7 d. */
  to: z.iso.datetime().optional(),
  impact: CalendarImpactSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

export const CalendarResponseSchema = z.object({
  /** Configured vendor ("forexfactory" | "none"). */
  provider: z.string(),
  /** False ⇒ blackout rule records `calendar_unavailable` and passes (fail-open). */
  available: z.boolean(),
  lastFetchedAt: z.iso.datetime().nullable(),
  /** ± window applied around high-impact events (risk-gate config). */
  blackoutMinutes: z.number().int(),
  events: z.array(EconomicCalendarEventSchema),
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;
