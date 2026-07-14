import type { LivePromotionCheck, LivePromotionResponse } from '@fx/types';

/**
 * BE-101 — the live-promotion gate. Live mode is blocked until every
 * checklist item passes; unmet items come back with the 403 so the operator
 * sees exactly what's missing (AC). The checks are deliberately conservative:
 * anything unknown/unqueryable counts as UNMET (fail-safe direction).
 *
 * TRADING_MODE itself stays an env flag (BE-003 — one code path, set at
 * deploy): an allowed POST records an audited promotion approval; the flip to
 * `live` is the documented deploy step (see PHASE5_TESTING_GUIDE).
 *
 * Phase-6 seams surfaced honestly:
 *   - `paper_window_90d` — QN-060 (90-day paper vs baseline validator) lands
 *     in Phase 6; until it writes its verdict there is nothing to pass.
 *   - `signed_risk_report` — QN-061 lands in Phase 6.
 */

export interface LivePromotionFacts {
  /** Fresh step-up 2FA on the requesting user (guard-enforced upstream). */
  stepUpFresh: boolean;
  /** Latest champion in model_registry (any instrument/tf), if one exists. */
  champion: { instrument: string; timeframe: string; version: number } | null;
  /** Latest FINISHED backtest run's validation verdict (QN-053). */
  latestValidationVerdict: string | null;
  /** QN-060 90-day paper validation record — Phase 6; null until it exists. */
  paperValidation: { verdict: string; at: Date } | null;
  /** QN-061 signed risk report — Phase 6; null until it exists. */
  signedRiskReport: { at: Date } | null;
  killSwitchActive: boolean;
}

export function evaluateLivePromotion(facts: LivePromotionFacts): LivePromotionResponse {
  const checklist: LivePromotionCheck[] = [
    {
      id: 'step_up_2fa',
      label: 'Fresh step-up 2FA on the requesting operator',
      ok: facts.stepUpFresh,
      detail: facts.stepUpFresh ? 'verified within the step-up window' : 'step-up 2FA required',
    },
    {
      id: 'champion_model',
      label: 'A champion model is promoted in the registry',
      ok: facts.champion !== null,
      detail: facts.champion
        ? `${facts.champion.instrument}/${facts.champion.timeframe} v${facts.champion.version}`
        : 'no champion in model_registry — train + promote first (QN-046)',
    },
    {
      id: 'model_validated',
      label: 'Latest finished backtest verdict is VALIDATED (QN-053)',
      ok: facts.latestValidationVerdict === 'VALIDATED',
      detail:
        facts.latestValidationVerdict === null
          ? 'no finished backtest with a validation verdict yet'
          : `latest verdict: ${facts.latestValidationVerdict}`,
    },
    {
      id: 'paper_window_90d',
      label: '90-day paper window beats shadow baseline net of LLM cost (QN-060)',
      ok: facts.paperValidation?.verdict === 'PASS',
      detail: facts.paperValidation
        ? `verdict ${facts.paperValidation.verdict} at ${facts.paperValidation.at.toISOString()}`
        : 'no QN-060 paper-validation record (validator lands in Phase 6)',
    },
    {
      id: 'signed_risk_report',
      label: 'Signed risk report generated (QN-061)',
      ok: facts.signedRiskReport !== null,
      detail: facts.signedRiskReport
        ? `signed at ${facts.signedRiskReport.at.toISOString()}`
        : 'no signed risk report (generator lands in Phase 6)',
    },
    {
      id: 'kill_switch_inactive',
      label: 'Kill-switch is not active',
      ok: !facts.killSwitchActive,
      detail: facts.killSwitchActive ? 'kill-switch is ACTIVE — deactivate first' : null,
    },
  ];

  return {
    allowed: checklist.every((c) => c.ok),
    checklist,
    note: 'TRADING_MODE stays an env flag (BE-003). An allowed POST records an audited promotion approval; flipping the flag to `live` is the deploy step.',
  };
}
