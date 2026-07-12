import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIAL_CHANGE_CONFIG,
  detectMaterialChange,
  rBucket,
  type SupervisionSnapshot,
  unrealizedR,
} from './material-change.js';

/** BE-080 — the deterministic gate: LLM only on material change. */

function snap(overrides: Partial<SupervisionSnapshot> = {}): SupervisionSnapshot {
  return {
    rMultiple: 0.1,
    sessionLabel: 'LONDON',
    liquidityRegime: 'NORMAL',
    holdingHours: 5,
    tripleSwapAhead: false,
    weekendGapWindow: false,
    highImpactEventWithinBlackout: false,
    ...overrides,
  };
}

describe('detectMaterialChange', () => {
  it('first supervision (no previous snapshot) is always material', () => {
    const r = detectMaterialChange(null, snap());
    expect(r.material).toBe(true);
    expect(r.reasons).toEqual(['first_supervision']);
  });

  it('nothing changed ⇒ NOT material (the zero-LLM-cost path)', () => {
    const r = detectMaterialChange(snap(), snap({ rMultiple: 0.12, holdingHours: 6 }));
    expect(r.material).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('crossing an R bucket boundary is material', () => {
    const r = detectMaterialChange(snap({ rMultiple: 0.4 }), snap({ rMultiple: 0.6 }));
    expect(r.material).toBe(true);
    expect(r.reasons[0]).toMatch(/r_multiple_bucket_change/);
  });

  it('deep adverse excursion adds the adverse reason', () => {
    const r = detectMaterialChange(snap({ rMultiple: -0.4 }), snap({ rMultiple: -0.9 }));
    expect(r.material).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('adverse_excursion'))).toBe(true);
  });

  it('does NOT re-fire adverse while parked underwater in the same bucket', () => {
    const r = detectMaterialChange(snap({ rMultiple: -0.9 }), snap({ rMultiple: -0.85 }));
    expect(r.material).toBe(false);
  });

  it('session and liquidity transitions are material', () => {
    expect(detectMaterialChange(snap(), snap({ sessionLabel: 'OFF_HOURS' })).reasons[0]).toMatch(
      /session_change/,
    );
    expect(detectMaterialChange(snap(), snap({ liquidityRegime: 'LOW' })).reasons[0]).toMatch(
      /liquidity_change/,
    );
  });

  it('flag EDGES are material, steady state is not', () => {
    expect(detectMaterialChange(snap(), snap({ tripleSwapAhead: true })).material).toBe(true);
    expect(
      detectMaterialChange(snap({ tripleSwapAhead: true }), snap({ tripleSwapAhead: true }))
        .material,
    ).toBe(false);
    expect(detectMaterialChange(snap(), snap({ weekendGapWindow: true })).material).toBe(true);
    expect(
      detectMaterialChange(snap(), snap({ highImpactEventWithinBlackout: true })).material,
    ).toBe(true);
  });

  it('approaching the time stop fires exactly once at the warn boundary', () => {
    const cfg = DEFAULT_MATERIAL_CHANGE_CONFIG; // warn at 57.6h of 72h
    const before = snap({ holdingHours: 57 });
    const after = snap({ holdingHours: 58 });
    expect(detectMaterialChange(before, after, cfg).material).toBe(true);
    expect(
      detectMaterialChange(snap({ holdingHours: 58 }), snap({ holdingHours: 60 }), cfg).material,
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('rBucket floors into fixed-width buckets', () => {
    expect(rBucket(0.4, 0.5)).toBe(0);
    expect(rBucket(0.6, 0.5)).toBe(1);
    expect(rBucket(-0.1, 0.5)).toBe(-1);
    expect(rBucket(-0.9, 0.5)).toBe(-2);
  });

  it('unrealizedR is signed by side and guards zero risk', () => {
    expect(unrealizedR('long', 1.1, 1.11, 0.01)).toBeCloseTo(1);
    expect(unrealizedR('short', 1.1, 1.11, 0.01)).toBeCloseTo(-1);
    expect(unrealizedR('long', 1.1, 1.2, 0)).toBe(0);
  });
});
