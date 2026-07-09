import type { AccountState, QuantCandidate } from '@fx/types';

/**
 * BE-066 — the risk-gate SEAM the signals worker calls between the PM's
 * APPROVE and execution. The real rule engine is BE-070 (Step 3.3,
 * `packages/risk-gate`); until it lands the default implementation VETOES
 * EVERYTHING — fail-safe: an agent APPROVE can never reach the execution
 * queue without the deterministic final authority in place (§10).
 *
 * §2.2: risk-gate evaluation budget is 2s; overrun or throw ⇒ VETO
 * (fail-safe), enforced by `evaluateWithTimeout`.
 */

export interface RiskGateInput {
  candidate: QuantCandidate;
  account: AccountState;
  /** Instruments currently flagged degraded by BE-044 (blocks execution). */
  degradedInstruments: string[];
  barTs: Date;
}

export interface RiskGateVerdict {
  verdict: 'approve' | 'veto';
  /** Machine-readable reason when vetoed (audit + BE-065 joins). */
  reasonCode: string | null;
  /** Every rule evaluated + result — persisted to trade_intents.risk_gate. */
  checks: Record<string, unknown>;
}

export interface RiskGate {
  evaluate(input: RiskGateInput): Promise<RiskGateVerdict>;
}

/** Placeholder until BE-070: deterministic fail-safe VETO. */
export class NotImplementedRiskGate implements RiskGate {
  async evaluate(): Promise<RiskGateVerdict> {
    return {
      verdict: 'veto',
      reasonCode: 'RISK_GATE_NOT_IMPLEMENTED',
      checks: { engine: 'not_implemented (BE-070, Step 3.3)' },
    };
  }
}

export const RISK_GATE_BUDGET_MS = 2_000;

/** §2.2 fail-safe wrapper: budget overrun or throw ⇒ VETO, never a crash. */
export async function evaluateWithTimeout(
  gate: RiskGate,
  input: RiskGateInput,
  budgetMs: number = RISK_GATE_BUDGET_MS,
): Promise<RiskGateVerdict> {
  const timeout = Symbol('risk-gate-timeout');
  try {
    const verdict = await Promise.race([
      gate.evaluate(input),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), budgetMs)),
    ]);
    if (verdict === timeout) {
      return {
        verdict: 'veto',
        reasonCode: 'RISK_GATE_TIMEOUT',
        checks: { error: `evaluation exceeded ${budgetMs}ms` },
      };
    }
    return verdict;
  } catch (err) {
    return {
      verdict: 'veto',
      reasonCode: 'RISK_GATE_ERROR',
      checks: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
