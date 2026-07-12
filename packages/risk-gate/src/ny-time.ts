/**
 * BE-070 — DST-aware New York wall-clock helpers.
 *
 * Every session/rollover/weekend rule in §10 is anchored to 17:00
 * **America/New_York** (IANA tz — never fixed UTC hours). Node's `Intl`
 * carries the full tz database, so the conversion is exact across DST
 * transitions without any dependency. Mirrors the Python side
 * (`services/quant/app/quant/sessions.py`) — the quant features are the
 * primary source; these helpers are the gate's independent check and the
 * fallback when a feature is absent.
 */

const NY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface NyWallClock {
  /** 0 = Sunday … 6 = Saturday (New York local). */
  weekday: number;
  hour: number;
  minute: number;
}

export function nyWallClock(ts: Date): NyWallClock {
  const parts = NY_FORMATTER.formatToParts(ts);
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = WEEKDAYS[part.value] ?? 0;
    // 'h23' still emits '24' for midnight in some ICU versions — normalize.
    if (part.type === 'hour') hour = Number(part.value) % 24;
    if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, hour, minute };
}

/**
 * FX market weekend closure: Friday 17:00 NY → Sunday 17:00 NY (DST-aware).
 */
export function isWeekendClosure(ts: Date): boolean {
  const { weekday, hour } = nyWallClock(ts);
  if (weekday === 6) return true; // all of Saturday
  if (weekday === 5 && hour >= 17) return true; // Friday post-close
  if (weekday === 0 && hour < 17) return true; // Sunday pre-open
  return false;
}

/**
 * True inside the pre-close window before Friday 17:00 New York (DST-aware).
 * Matches Python `in_weekend_gap_window` (default 6h window).
 */
export function inFridayPreCloseWindow(ts: Date, windowHours = 6): boolean {
  const { weekday, hour, minute } = nyWallClock(ts);
  if (weekday !== 5) return false;
  const hoursToClose = 17 - (hour + minute / 60);
  return hoursToClose > 0 && hoursToClose <= windowHours;
}

/** True when `ts` falls on Wednesday (NY local) — the triple-swap day. */
export function isNyWednesday(ts: Date): boolean {
  return nyWallClock(ts).weekday === 3;
}

/**
 * QN-047 mirror: a position opened at `openedAt` and held >2 days as of
 * `asOf` on a Wednesday (NY) is flagged for the triple-swap rollover warning.
 */
export function tripleSwapWarning(openedAt: Date, asOf: Date): boolean {
  const heldMs = asOf.getTime() - openedAt.getTime();
  return isNyWednesday(asOf) && heldMs > 2 * 24 * 3_600_000;
}
