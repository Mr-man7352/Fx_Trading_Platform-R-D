import type { AccountState, QuantCandidate } from '@fx/types';

/**
 * BE-070/071 — inputs, config, and verdict shapes for the deterministic
 * rule engine. The engine is PURE: every fact it needs arrives in
 * `RiskGateContext` (gathered by the node-api adapter), so every rule and
 * combination is unit-testable with plain fixtures (§10: never delegated
 * to an LLM; "Node never does maths" — clusters and features come computed
 * from Python, the engine only compares them against configured limits).
 */

// ─── Context (facts) ─────────────────────────────────────────────────────────

export interface OpenPositionInfo {
  instrument: string;
  openedAt: Date;
}

export interface EconomicEvent {
  ts: Date;
  impact: 'high' | 'medium' | 'low';
  /** ISO currency codes the event touches, e.g. ['USD']. */
  currencies: string[];
}

export interface RiskGateContext {
  candidate: QuantCandidate;
  account: AccountState;
  /** Decision time = close time of the bar that fired the cycle. */
  barTs: Date;
  /** BE-044 — instruments currently flagged degraded (blocks execution). */
  degradedInstruments: string[];
  /** BE-073 — Postgres-hydrated kill-switch state (Redis is cache only). */
  killSwitchActive: boolean;
  /** Realized P&L this ISO week (UTC Monday) as a fraction of equity. */
  weeklyPnlPct: number;
  /** Realized LOSS today on the candidate's instrument, fraction of equity (≥ 0). */
  instrumentDailyLossPct: number;
  openPositions: OpenPositionInfo[];
  /** QN-048 — latest published cluster set ([] = no data yet). */
  clusters: string[][];
  clusterSetVersion: number | null;
  /** Calendar seam — no vendor wired in Phase 3; rule notes 'unavailable'. */
  calendarAvailable: boolean;
  upcomingEvents: EconomicEvent[];
  /** QN-047 session features from the pipeline (DST-aware, computed in Python). */
  sessionLabel: string;
  liquidityRegime: string;
  /** Live spread in pips (null when no spread feed — dev/mock). */
  spreadPips: number | null;
  /** Causal trailing percentile rank of the current spread (0..1, null = n/a). */
  spreadPctile: number | null;
  /** features.weekend_gap_window (null ⇒ engine computes DST-aware itself). */
  weekendGapWindow: boolean | null;
}

// ─── Config (limits — defaults from system design §10) ──────────────────────

export interface RiskGateConfig {
  /** ADR-008 — min calibrated P(profitable). */
  minProbability: number;
  maxConcurrentTrades: number;
  /** BE-071 — max open trades per correlation cluster (incl. the candidate). */
  maxPerCluster: number;
  /** Operator override: instruments exempt from the cluster cap (audited). */
  clusterExemptInstruments: string[];
  dailyDrawdownHaltPct: number;
  weeklyDrawdownHaltPct: number;
  /** Early-warning tripwire — the daily halt still binds first. */
  instrumentDailyLossPct: number;
  /** Min reward:risk net of spread costs. */
  minRiskReward: number;
  /** ± minutes around a high-impact event (blackout). */
  blackoutMinutes: number;
  weekendFlattenEnabled: boolean;
  weekendGapWindowHours: number;
  rolloverAutoFlattenXau: boolean;
  /** Max spread cap in pips per instrument; fallback `defaultMaxSpreadPips`. */
  maxSpreadPips: Record<string, number>;
  defaultMaxSpreadPips: number;
  /** §10 session multiplier: 1.5× overnight (Tokyo/Sydney/off-hours). */
  offHoursSpreadMultiplier: number;
  /** Flash-crash trigger: spread ≥ this multiple of the cap ⇒ halt + alert. */
  flashSpreadMultiple: number;
}

export const DEFAULT_RISK_GATE_CONFIG: RiskGateConfig = {
  minProbability: 0.6,
  maxConcurrentTrades: 5,
  maxPerCluster: 2,
  clusterExemptInstruments: [],
  dailyDrawdownHaltPct: 0.05,
  weeklyDrawdownHaltPct: 0.1,
  instrumentDailyLossPct: 0.02,
  minRiskReward: 1.8,
  blackoutMinutes: 30,
  weekendFlattenEnabled: false,
  weekendGapWindowHours: 6,
  rolloverAutoFlattenXau: false,
  // §10: 3 pips FX, 50¢ XAU (pip = 0.01 ⇒ 50 pips), 5¢ oil.
  maxSpreadPips: { XAU_USD: 50 },
  defaultMaxSpreadPips: 3,
  offHoursSpreadMultiplier: 1.5,
  flashSpreadMultiple: 5,
};

// ─── Verdict ─────────────────────────────────────────────────────────────────

export interface RuleCheck {
  pass: boolean;
  detail: string;
  /** Set on failed rules — the machine-readable veto reason. */
  reasonCode?: string;
}

export interface RiskFlag {
  flag: string;
  detail: string;
}

export interface RiskAlert {
  severity: 'warning' | 'critical';
  title: string;
  body: string;
}

export interface RiskGateResult {
  verdict: 'approve' | 'veto';
  /** First failing rule's code (rules evaluate in §10 order). */
  reasonCode: string | null;
  /** EVERY rule evaluated + result — persisted to trade_intents.risk_gate. */
  checks: Record<string, RuleCheck>;
  /** Non-veto advisories (weekend flatten, triple-swap warning, …). */
  flags: RiskFlag[];
  /** Operator alerts the caller must fan out (flash spread ⇒ critical). */
  alerts: RiskAlert[];
}
