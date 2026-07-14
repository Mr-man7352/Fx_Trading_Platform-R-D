import { describe, expect, it } from 'vitest';
import { evaluateLivePromotion, type LivePromotionFacts } from './live-promotion.js';

/** BE-101 — 403-with-checklist semantics: anything unknown counts as UNMET. */

const ALL_MET: LivePromotionFacts = {
  stepUpFresh: true,
  champion: { instrument: 'XAU_USD', timeframe: 'H1', version: 2 },
  latestValidationVerdict: 'VALIDATED',
  paperValidation: { verdict: 'PASS', at: new Date('2026-07-01T00:00:00Z') },
  signedRiskReport: { at: new Date('2026-07-02T00:00:00Z') },
  killSwitchActive: false,
};

describe('evaluateLivePromotion (BE-101)', () => {
  it('allows only when EVERY checklist item passes', () => {
    const res = evaluateLivePromotion(ALL_MET);
    expect(res.allowed).toBe(true);
    expect(res.checklist.every((c) => c.ok)).toBe(true);
  });

  it('blocks with the exact unmet conditions listed (AC)', () => {
    const res = evaluateLivePromotion({
      ...ALL_MET,
      latestValidationVerdict: 'NOT VALIDATED',
      paperValidation: null,
      signedRiskReport: null,
    });
    expect(res.allowed).toBe(false);
    const unmet = res.checklist.filter((c) => !c.ok).map((c) => c.id);
    expect(unmet).toEqual(['model_validated', 'paper_window_90d', 'signed_risk_report']);
    const verdictItem = res.checklist.find((c) => c.id === 'model_validated');
    expect(verdictItem?.detail).toContain('NOT VALIDATED');
  });

  it('missing champion and active kill-switch block promotion (fail-safe)', () => {
    const res = evaluateLivePromotion({ ...ALL_MET, champion: null, killSwitchActive: true });
    expect(res.allowed).toBe(false);
    const unmet = res.checklist.filter((c) => !c.ok).map((c) => c.id);
    expect(unmet).toContain('champion_model');
    expect(unmet).toContain('kill_switch_inactive');
  });

  it('stale step-up 2FA is an unmet condition', () => {
    const res = evaluateLivePromotion({ ...ALL_MET, stepUpFresh: false });
    expect(res.allowed).toBe(false);
    expect(res.checklist.find((c) => c.id === 'step_up_2fa')?.ok).toBe(false);
  });

  it('null verdict (no finished backtest) is unmet, not an error', () => {
    const res = evaluateLivePromotion({ ...ALL_MET, latestValidationVerdict: null });
    expect(res.allowed).toBe(false);
    expect(res.checklist.find((c) => c.id === 'model_validated')?.detail).toContain(
      'no finished backtest',
    );
  });
});
