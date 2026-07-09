import type { AgentGraphResult } from './agent-graph.js';

/**
 * BE-065 — disagreement cohort logging.
 *
 * "Quant approves" ≡ the candidate's calibrated P(profitable) clears the
 * risk-gate threshold (ADR-008, default 0.60) — i.e. the deterministic
 * stack alone would have traded. A disagreement row is written whenever the
 * PM decision conflicts with that:
 *
 * - `QUANT_YES_PM_VETO`   — quant would trade, PM actively vetoed.
 * - `QUANT_YES_PM_HOLD`   — quant would trade, PM held (incl. deterministic
 *                            HOLDs from stage failures — cohort-queryable by
 *                            joining agent_runs / hold reasons).
 * - `QUANT_NO_PM_APPROVE` — quant would NOT trade (candidate exists but
 *                            P < threshold), PM approved anyway. The risk
 *                            gate (BE-070) still vetoes execution — the row
 *                            measures agent optimism, not a trade.
 *
 * Outcome tracking is by JOIN, not duplication: signal_id → trade_intents →
 * trades for executed candidates; for vetoed ones the counterfactual lives
 * in `baseline_signals` (the QN-044 shadow baseline logs every bar
 * regardless of agent outcome).
 */

export type DisagreementKind = 'QUANT_YES_PM_VETO' | 'QUANT_YES_PM_HOLD' | 'QUANT_NO_PM_APPROVE';

export function classifyDisagreement(
  quantProbability: number,
  probabilityThreshold: number,
  decision: AgentGraphResult['decision'],
): DisagreementKind | null {
  const quantWouldTrade = quantProbability >= probabilityThreshold;
  if (quantWouldTrade && decision === 'VETO') return 'QUANT_YES_PM_VETO';
  if (quantWouldTrade && decision === 'HOLD') return 'QUANT_YES_PM_HOLD';
  if (!quantWouldTrade && decision === 'APPROVE') return 'QUANT_NO_PM_APPROVE';
  return null;
}

/** Structural seam over the generated Prisma delegate (testable pre-generate). */
export interface DisagreementWriter {
  disagreementEvent: {
    create(args: {
      data: {
        signalId: string;
        kind: string;
        quantProbability: number;
        pmDecision: string;
        pmRationale: string | null;
      };
    }): Promise<unknown>;
  };
}

/**
 * Evaluate one completed graph run and persist a cohort row when quant and
 * PM disagree. Returns the kind written, or null when they agree.
 */
export async function logDisagreement(
  db: DisagreementWriter,
  params: {
    signalId: string;
    quantProbability: number;
    probabilityThreshold: number;
    result: AgentGraphResult;
  },
): Promise<DisagreementKind | null> {
  const kind = classifyDisagreement(
    params.quantProbability,
    params.probabilityThreshold,
    params.result.decision,
  );
  if (kind === null) return null;
  await db.disagreementEvent.create({
    data: {
      signalId: params.signalId,
      kind,
      quantProbability: params.quantProbability,
      pmDecision: params.result.decision,
      pmRationale: params.result.pm?.rationale ?? params.result.holdDetail,
    },
  });
  return kind;
}
