import type { TradeSide } from '@fx/types';

/**
 * BE-080 — the deterministic supervision gate (mirrors the ADR-010 entry
 * gate): the LLM supervisor runs ONLY on material change. Pure function of
 * two snapshots — no I/O, no clock reads — so the "nothing changed ⇒ HOLD
 * with zero LLM cost" AC is directly unit-testable.
 *
 * A snapshot is taken every supervision tick and persisted to
 * `trade.meta.supervisionSnapshot`; the gate compares the fresh snapshot
 * against the last one the LLM actually saw.
 */

export interface SupervisionSnapshot {
  /** Unrealized R-multiple vs ORIGINAL risk distance. */
  rMultiple: number;
  sessionLabel: string;
  liquidityRegime: string;
  /** Holding hours at snapshot time. */
  holdingHours: number;
  tripleSwapAhead: boolean;
  weekendGapWindow: boolean;
  highImpactEventWithinBlackout: boolean;
}

export interface MaterialChangeConfig {
  /** R-multiple bucket width — crossing a bucket boundary is material. */
  rBucketSize: number;
  /** Adverse excursion beyond this (negative R) is always material. */
  adverseR: number;
  /** Fraction of the time stop after which approaching-expiry is material. */
  timeStopWarnFraction: number;
  timeStopHours: number;
}

export const DEFAULT_MATERIAL_CHANGE_CONFIG: MaterialChangeConfig = {
  rBucketSize: 0.5,
  adverseR: -0.75,
  timeStopWarnFraction: 0.8,
  timeStopHours: 72,
};

export interface MaterialChangeResult {
  material: boolean;
  reasons: string[];
}

export function rBucket(r: number, size: number): number {
  // Round the quotient to absorb IEEE-754 noise before flooring: an R-multiple
  // computed from real prices routinely lands a hair below an exact boundary
  // (e.g. 1.105 - 1.1 = 0.00499999… ⇒ 0.4999999999R), which would otherwise
  // floor into the LOWER bucket and spuriously mark the tick material —
  // firing a needless LLM call on pure price noise (violates the zero-cost gate AC).
  const rounded = Math.round((r / size) * 1e9) / 1e9;
  return Math.floor(rounded);
}

/**
 * Compare the fresh snapshot against the one from the last LLM supervision.
 * `previous === null` (first supervision of this trade) is material by
 * definition — the supervisor establishes its baseline read.
 */
export function detectMaterialChange(
  previous: SupervisionSnapshot | null,
  current: SupervisionSnapshot,
  config: MaterialChangeConfig = DEFAULT_MATERIAL_CHANGE_CONFIG,
): MaterialChangeResult {
  if (previous === null) {
    return { material: true, reasons: ['first_supervision'] };
  }
  const reasons: string[] = [];

  const prevBucket = rBucket(previous.rMultiple, config.rBucketSize);
  const currBucket = rBucket(current.rMultiple, config.rBucketSize);
  if (currBucket !== prevBucket) {
    reasons.push(
      `r_multiple_bucket_change:${previous.rMultiple.toFixed(2)}R->${current.rMultiple.toFixed(2)}R`,
    );
  }
  // Adverse excursion re-fires whenever the trade sets a NEW low bucket below
  // the threshold (not on every tick spent underwater).
  if (
    current.rMultiple <= config.adverseR &&
    currBucket < prevBucket // deteriorated since last supervision
  ) {
    reasons.push(`adverse_excursion:${current.rMultiple.toFixed(2)}R<=${config.adverseR}R`);
  }
  if (current.sessionLabel !== previous.sessionLabel) {
    reasons.push(`session_change:${previous.sessionLabel}->${current.sessionLabel}`);
  }
  if (current.liquidityRegime !== previous.liquidityRegime) {
    reasons.push(`liquidity_change:${previous.liquidityRegime}->${current.liquidityRegime}`);
  }
  if (current.tripleSwapAhead && !previous.tripleSwapAhead) {
    reasons.push('triple_swap_rollover_ahead');
  }
  if (current.weekendGapWindow && !previous.weekendGapWindow) {
    reasons.push('entered_weekend_gap_window');
  }
  if (current.highImpactEventWithinBlackout && !previous.highImpactEventWithinBlackout) {
    reasons.push('news_blackout_approaching');
  }
  const warnAt = config.timeStopHours * config.timeStopWarnFraction;
  if (current.holdingHours >= warnAt && previous.holdingHours < warnAt) {
    reasons.push(
      `time_stop_approaching:${current.holdingHours.toFixed(1)}h/${config.timeStopHours}h`,
    );
  }

  return { material: reasons.length > 0, reasons };
}

/** Unrealized R-multiple (shared with the worker; sign follows the side). */
export function unrealizedR(
  side: TradeSide,
  entry: number,
  current: number,
  originalRiskDistance: number,
): number {
  if (originalRiskDistance <= 0) return 0;
  const move = side === 'long' ? current - entry : entry - current;
  return move / originalRiskDistance;
}
