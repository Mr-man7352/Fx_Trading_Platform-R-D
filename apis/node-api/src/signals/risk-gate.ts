import {
  DEFAULT_RISK_GATE_CONFIG,
  type EconomicEvent,
  evaluateRiskGate,
  type RiskAlert,
  type RiskFlag,
  type RiskGateConfig,
} from '@fx/risk-gate';
import type { AccountState, QuantCandidate } from '@fx/types';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import type { KillSwitchStore } from '../execution/kill-switch.js';
import type { SettingsReader } from '../settings/settings-service.js';

/**
 * BE-066/070 — the risk-gate seam the signals worker calls between the PM's
 * APPROVE and execution, now backed by the REAL deterministic rule engine
 * (`@fx/risk-gate`, BE-070/071 — final authority, §10).
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
  /** QN-047 session features from the pipeline result (BE-066 passes them). */
  sessionLabel?: string;
  liquidityRegime?: string;
  features?: Record<string, number>;
}

export interface RiskGateVerdict {
  verdict: 'approve' | 'veto';
  /** Machine-readable reason when vetoed (audit + BE-065 joins). */
  reasonCode: string | null;
  /** Every rule evaluated + result — persisted to trade_intents.risk_gate. */
  checks: Record<string, unknown>;
  /** Non-veto advisories (weekend flatten, triple-swap, cluster exemption). */
  flags?: RiskFlag[];
  /** Operator alerts the worker must fan out (flash spread ⇒ critical). */
  alerts?: RiskAlert[];
}

export interface RiskGate {
  evaluate(input: RiskGateInput): Promise<RiskGateVerdict>;
}

/** Fail-safe VETO stub — kept for tests and as the wiring default of last resort. */
export class NotImplementedRiskGate implements RiskGate {
  async evaluate(): Promise<RiskGateVerdict> {
    return {
      verdict: 'veto',
      reasonCode: 'RISK_GATE_NOT_IMPLEMENTED',
      checks: { engine: 'not_implemented (BE-070, Step 3.3)' },
    };
  }
}

/** Seam for the economic calendar — no vendor wired in Phase 3 (engine notes it). */
export interface CalendarProvider {
  available(): boolean;
  eventsAround(barTs: Date, windowMinutes: number): Promise<EconomicEvent[]>;
}

export const NO_CALENDAR: CalendarProvider = {
  available: () => false,
  eventsAround: async () => [],
};

export function riskGateConfigFromEnv(env: Env): RiskGateConfig {
  return {
    ...DEFAULT_RISK_GATE_CONFIG,
    minProbability: env.RISK_PROBABILITY_THRESHOLD,
    maxConcurrentTrades: env.RISK_MAX_CONCURRENT_TRADES,
    maxPerCluster: env.RISK_MAX_PER_CLUSTER,
    clusterExemptInstruments: env.RISK_CLUSTER_EXEMPTIONS,
    dailyDrawdownHaltPct: env.RISK_DAILY_DD_HALT_PCT,
    weeklyDrawdownHaltPct: env.RISK_WEEKLY_DD_HALT_PCT,
    instrumentDailyLossPct: env.RISK_INSTRUMENT_DAILY_LOSS_PCT,
    minRiskReward: env.RISK_MIN_RR,
    weekendFlattenEnabled: env.RISK_WEEKEND_FLATTEN_ENABLED,
    rolloverAutoFlattenXau: env.RISK_ROLLOVER_AUTOFLATTEN_XAU,
  };
}

/**
 * BE-070 — gathers the facts the pure engine needs (clusters, open book,
 * realized P&L windows, kill-switch state) and evaluates. Any gather failure
 * propagates to `evaluateWithTimeout`, which converts it to a VETO — the
 * gate NEVER approves on missing mandatory inputs.
 */
export class DeterministicRiskGate implements RiskGate {
  private readonly baseConfig: RiskGateConfig;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly killSwitch: KillSwitchStore,
    env: Env,
    private readonly calendar: CalendarProvider = NO_CALENDAR,
    /** BE-100 — operator settings overlay ("next cycle uses new values"). */
    private readonly settings: SettingsReader | null = null,
  ) {
    this.baseConfig = riskGateConfigFromEnv(env);
  }

  /** Env config with the BE-100 settings overlay (fail-open to env values). */
  private async effectiveConfig(): Promise<RiskGateConfig> {
    if (!this.settings) return this.baseConfig;
    try {
      const s = await this.settings.effective();
      return {
        ...this.baseConfig,
        instrumentDailyLossPct: s.risk.perInstrumentDailyLossPct,
        weekendFlattenEnabled: s.risk.weekendGapFlatten,
      };
    } catch {
      return this.baseConfig; // a settings read failure never blocks the gate
    }
  }

  async evaluate(input: RiskGateInput): Promise<RiskGateVerdict> {
    const { candidate, account, barTs } = input;
    const config = await this.effectiveConfig();

    const [killSwitchActive, clusterSet, openTrades, weeklyClosed, instrumentToday, events] =
      await Promise.all([
        this.killSwitch.isActive(),
        this.prisma.correlationClusterSet.findFirst({ orderBy: { version: 'desc' } }),
        this.prisma.trade.findMany({
          where: { status: 'open' },
          select: { instrument: true, openedAt: true },
        }),
        this.prisma.trade.aggregate({
          _sum: { realizedPnl: true },
          where: { status: 'closed', closedAt: { gte: startOfUtcWeek() } },
        }),
        this.prisma.trade.aggregate({
          _sum: { realizedPnl: true },
          where: {
            status: 'closed',
            instrument: candidate.instrument,
            closedAt: { gte: startOfUtcDay() },
          },
        }),
        this.calendar.eventsAround(barTs, config.blackoutMinutes),
      ]);

    const equity = account.equity > 0 ? account.equity : 1;
    const weeklyPnl = num(weeklyClosed._sum.realizedPnl);
    const instrumentPnl = num(instrumentToday._sum.realizedPnl);

    const result = evaluateRiskGate(
      {
        candidate,
        account,
        barTs,
        degradedInstruments: input.degradedInstruments,
        killSwitchActive,
        weeklyPnlPct: weeklyPnl / equity,
        instrumentDailyLossPct: Math.max(0, -instrumentPnl) / equity,
        openPositions: openTrades.map((t) => ({ instrument: t.instrument, openedAt: t.openedAt })),
        clusters: parseClusters(clusterSet?.clusters),
        clusterSetVersion: clusterSet?.version ?? null,
        calendarAvailable: this.calendar.available(),
        upcomingEvents: events,
        sessionLabel: input.sessionLabel ?? 'OFF_HOURS',
        liquidityRegime: input.liquidityRegime ?? 'NORMAL',
        spreadPips: input.features?.spread_pips ?? null,
        spreadPctile: input.features?.spread_pctile ?? null,
        weekendGapWindow:
          input.features?.weekend_gap_window === undefined
            ? null
            : input.features.weekend_gap_window === 1,
      },
      config,
    );

    return {
      verdict: result.verdict,
      reasonCode: result.reasonCode,
      checks: result.checks,
      flags: result.flags,
      alerts: result.alerts,
    };
  }
}

function parseClusters(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is unknown[] => Array.isArray(c))
    .map((c) => c.filter((i): i is string => typeof i === 'string'));
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** ISO week: Monday 00:00 UTC. */
function startOfUtcWeek(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const sinceMonday = (day + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday),
  );
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
