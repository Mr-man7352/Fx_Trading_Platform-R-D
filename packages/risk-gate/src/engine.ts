import { inFridayPreCloseWindow, isWeekendClosure, tripleSwapWarning } from './ny-time.js';
import type {
  RiskAlert,
  RiskFlag,
  RiskGateConfig,
  RiskGateContext,
  RiskGateResult,
  RuleCheck,
} from './types.js';

/**
 * BE-070 — the deterministic rule engine: FINAL AUTHORITY on every entry
 * (§10 — hard rules enforced in code; never delegated to an LLM).
 *
 * Behavioural contract:
 * - ALL rules are evaluated on every call (never short-circuit) so the
 *   persisted `checks` record is complete for audit even when an early rule
 *   already vetoed — the BE-070 AC ("all rules in §10 checked") and the
 *   BE-065 cohort analysis both need the full picture.
 * - Verdict is VETO if ANY veto-class rule fails; `reasonCode` is the FIRST
 *   failing rule in §10 order.
 * - Missing optional data (spread feed, calendar vendor) is recorded
 *   explicitly in the check detail and does not veto — but the gate's OWN
 *   inputs (kill-switch state, account, candidate) are mandatory: the
 *   node-api adapter fails-safe (VETO) when it cannot gather them.
 */

// pip sizes for spread→price conversion (R:R net of costs).
function pipSize(instrument: string): number {
  if (instrument.endsWith('_JPY')) return 0.01;
  if (instrument === 'XAU_USD') return 0.01;
  return 0.0001;
}

function instrumentCurrencies(instrument: string): string[] {
  return instrument.split('_');
}

export function evaluateRiskGate(ctx: RiskGateContext, config: RiskGateConfig): RiskGateResult {
  const checks: Record<string, RuleCheck> = {};
  const flags: RiskFlag[] = [];
  const alerts: RiskAlert[] = [];
  const { candidate, account } = ctx;

  // 1 — kill-switch / halt (BE-072/073: Postgres-hydrated, Redis cache only).
  checks.kill_switch = ctx.killSwitchActive
    ? { pass: false, reasonCode: 'HALTED', detail: 'kill-switch active — all trading halted' }
    : { pass: true, detail: 'kill-switch inactive' };

  // 2 — degraded feed (BE-044): execution blocked on flagged instruments.
  const degraded = ctx.degradedInstruments.includes(candidate.instrument);
  checks.degraded_feed = degraded
    ? {
        pass: false,
        reasonCode: 'DEGRADED_FEED',
        detail: `${candidate.instrument} flagged degraded by data-quality monitor`,
      }
    : { pass: true, detail: 'feed healthy' };

  // 3 — market closed (weekend closure, Fri 17:00 → Sun 17:00 NY, DST-aware).
  const closed = isWeekendClosure(ctx.barTs);
  checks.market_closed = closed
    ? { pass: false, reasonCode: 'MARKET_CLOSED', detail: 'inside weekend closure (NY 17:00)' }
    : { pass: true, detail: 'market open' };

  // 4 — min entry probability (ADR-008: P ≥ 0.60 AND PM confirm).
  const probOk = candidate.probability >= config.minProbability;
  checks.probability = probOk
    ? { pass: true, detail: `P=${candidate.probability.toFixed(3)} ≥ ${config.minProbability}` }
    : {
        pass: false,
        reasonCode: 'PROB_BELOW_THRESHOLD',
        detail: `P=${candidate.probability.toFixed(3)} < ${config.minProbability}`,
      };

  // 5 — daily drawdown halt (5% default). dailyPnlPct is signed (loss < 0).
  const dailyBreached = account.dailyPnlPct <= -config.dailyDrawdownHaltPct;
  checks.daily_drawdown = dailyBreached
    ? {
        pass: false,
        reasonCode: 'DAILY_DD_HALT',
        detail: `daily P&L ${(account.dailyPnlPct * 100).toFixed(2)}% ≤ -${config.dailyDrawdownHaltPct * 100}%`,
      }
    : { pass: true, detail: `daily P&L ${(account.dailyPnlPct * 100).toFixed(2)}%` };

  // 6 — weekly drawdown halt (10% default).
  const weeklyBreached = ctx.weeklyPnlPct <= -config.weeklyDrawdownHaltPct;
  checks.weekly_drawdown = weeklyBreached
    ? {
        pass: false,
        reasonCode: 'WEEKLY_DD_HALT',
        detail: `weekly P&L ${(ctx.weeklyPnlPct * 100).toFixed(2)}% ≤ -${config.weeklyDrawdownHaltPct * 100}%`,
      }
    : { pass: true, detail: `weekly P&L ${(ctx.weeklyPnlPct * 100).toFixed(2)}%` };

  // 7 — per-instrument daily loss tripwire (2% default, early warning).
  const instrBreached = ctx.instrumentDailyLossPct > config.instrumentDailyLossPct;
  checks.instrument_daily_loss = instrBreached
    ? {
        pass: false,
        reasonCode: 'INSTRUMENT_DAILY_LOSS',
        detail: `${candidate.instrument} lost ${(ctx.instrumentDailyLossPct * 100).toFixed(2)}% of equity today > ${config.instrumentDailyLossPct * 100}%`,
      }
    : {
        pass: true,
        detail: `${candidate.instrument} daily loss ${(ctx.instrumentDailyLossPct * 100).toFixed(2)}%`,
      };

  // 8 — max concurrent trades (5 default).
  const concurrentOk = account.openPositions < config.maxConcurrentTrades;
  checks.max_concurrent = concurrentOk
    ? { pass: true, detail: `${account.openPositions}/${config.maxConcurrentTrades} open` }
    : {
        pass: false,
        reasonCode: 'MAX_CONCURRENT_TRADES',
        detail: `${account.openPositions} open ≥ cap ${config.maxConcurrentTrades}`,
      };

  // 9 — BE-071 correlation cluster cap (consumes QN-048; never computes).
  checks.correlation_cap = correlationCapRule(ctx, config, flags);

  // 10 — min R:R net of spread costs (1:1.8 default).
  checks.min_risk_reward = minRiskRewardRule(ctx, config);

  // 11 — flash-crash spread (>5× cap ⇒ halt new entries + critical alert).
  // Evaluated before the plain cap so the reason code names the flash event.
  const cap = config.maxSpreadPips[candidate.instrument] ?? config.defaultMaxSpreadPips;
  if (ctx.spreadPips === null) {
    checks.flash_spread = { pass: true, detail: 'no spread feed — not evaluated' };
    checks.max_spread = { pass: true, detail: 'no spread feed — not evaluated' };
  } else {
    const flash = ctx.spreadPips >= config.flashSpreadMultiple * cap;
    checks.flash_spread = flash
      ? {
          pass: false,
          reasonCode: 'FLASH_SPREAD',
          detail: `spread ${ctx.spreadPips} pips ≥ ${config.flashSpreadMultiple}× cap ${cap} (pctile=${ctx.spreadPctile ?? 'n/a'})`,
        }
      : { pass: true, detail: `spread ${ctx.spreadPips} pips < flash threshold` };
    if (flash) {
      flags.push({ flag: 'HALT_NEW_ENTRIES', detail: 'flash spread detected' });
      alerts.push({
        severity: 'critical',
        title: `Flash spread on ${candidate.instrument}`,
        body: `Spread ${ctx.spreadPips} pips ≥ ${config.flashSpreadMultiple}× cap ${cap} — new entries halted (§10). Existing positions: kill-switch only.`,
      });
    }

    // 12 — session-adjusted max spread (1.5× overnight, DST-aware labels from QN-047).
    const overnight = ctx.sessionLabel === 'OFF_HOURS' || ctx.sessionLabel === 'TOKYO';
    const mult = overnight ? config.offHoursSpreadMultiplier : 1.0;
    const limit = cap * mult;
    checks.max_spread =
      ctx.spreadPips > limit
        ? {
            pass: false,
            reasonCode: 'SPREAD_TOO_WIDE',
            detail: `spread ${ctx.spreadPips} pips > ${limit} (cap ${cap} × ${mult} ${ctx.sessionLabel})`,
          }
        : { pass: true, detail: `spread ${ctx.spreadPips} ≤ ${limit} (${ctx.sessionLabel})` };
  }

  // 13 — economic-event blackout (±30 min high-impact, per currency).
  checks.econ_blackout = blackoutRule(ctx, config);

  // 14 — weekend gap window (pre-Friday-close flatten, DST-aware).
  checks.weekend_gap = weekendGapRule(ctx, config, flags);

  // 15 — Wednesday rollover (triple swap): warning flags, optional XAU flatten.
  checks.rollover = rolloverRule(ctx, config, flags);

  // §10 order — first failing rule names the verdict.
  const order = [
    'kill_switch',
    'degraded_feed',
    'market_closed',
    'probability',
    'daily_drawdown',
    'weekly_drawdown',
    'instrument_daily_loss',
    'max_concurrent',
    'correlation_cap',
    'flash_spread',
    'max_spread',
    'min_risk_reward',
    'econ_blackout',
    'weekend_gap',
    'rollover',
  ];
  let failed: RuleCheck | null = null;
  for (const name of order) {
    const check = checks[name];
    if (check && !check.pass) {
      failed = check;
      break;
    }
  }

  return {
    verdict: failed ? 'veto' : 'approve',
    reasonCode: failed ? (failed.reasonCode ?? 'VETO') : null,
    checks,
    flags,
    alerts,
  };
}

// ─── Individual rules ────────────────────────────────────────────────────────

function correlationCapRule(
  ctx: RiskGateContext,
  config: RiskGateConfig,
  flags: RiskFlag[],
): RuleCheck {
  const { instrument } = ctx.candidate;
  if (ctx.clusters.length === 0) {
    return { pass: true, detail: 'no cluster set published yet (QN-048) — cap not evaluated' };
  }
  const cluster = ctx.clusters.find((c) => c.includes(instrument));
  if (!cluster) {
    return {
      pass: true,
      detail: `${instrument} not in any cluster (set v${ctx.clusterSetVersion ?? '?'})`,
    };
  }
  const openInCluster = ctx.openPositions.filter((p) => cluster.includes(p.instrument)).length;
  const wouldBe = openInCluster + 1;
  if (wouldBe > config.maxPerCluster) {
    if (config.clusterExemptInstruments.includes(instrument)) {
      // Operator override — allowed, but loudly flagged for the audit log.
      flags.push({
        flag: 'CLUSTER_EXEMPTION_USED',
        detail: `${instrument} exempt from cluster cap (would be ${wouldBe}/${config.maxPerCluster}, set v${ctx.clusterSetVersion})`,
      });
      return {
        pass: true,
        detail: `cluster cap exceeded (${wouldBe}/${config.maxPerCluster}) but ${instrument} is operator-exempt`,
      };
    }
    return {
      pass: false,
      reasonCode: 'CORRELATION_CAP',
      detail: `cluster [${cluster.join(', ')}] has ${openInCluster} open; +1 > cap ${config.maxPerCluster} (set v${ctx.clusterSetVersion})`,
    };
  }
  return {
    pass: true,
    detail: `cluster [${cluster.join(', ')}]: ${wouldBe}/${config.maxPerCluster} after entry (set v${ctx.clusterSetVersion})`,
  };
}

function minRiskRewardRule(ctx: RiskGateContext, config: RiskGateConfig): RuleCheck {
  const { candidate } = ctx;
  const spreadPrice = (ctx.spreadPips ?? 0) * pipSize(candidate.instrument);
  const reward = Math.abs(candidate.takeProfitPrice - candidate.entryPrice) - spreadPrice;
  const risk = Math.abs(candidate.entryPrice - candidate.stopLossPrice) + spreadPrice;
  if (risk <= 0) {
    return {
      pass: false,
      reasonCode: 'RR_BELOW_MIN',
      detail: 'degenerate bracket: stop distance ≤ 0',
    };
  }
  const rr = reward / risk;
  return rr >= config.minRiskReward
    ? { pass: true, detail: `R:R ${rr.toFixed(2)} ≥ ${config.minRiskReward} (net of spread)` }
    : {
        pass: false,
        reasonCode: 'RR_BELOW_MIN',
        detail: `R:R ${rr.toFixed(2)} < ${config.minRiskReward} (net of spread)`,
      };
}

function blackoutRule(ctx: RiskGateContext, config: RiskGateConfig): RuleCheck {
  if (!ctx.calendarAvailable) {
    return {
      pass: true,
      detail: 'no calendar vendor wired — blackout not evaluated (seam: CalendarProvider)',
    };
  }
  const currencies = instrumentCurrencies(ctx.candidate.instrument);
  const windowMs = config.blackoutMinutes * 60_000;
  const hit = ctx.upcomingEvents.find(
    (e) =>
      e.impact === 'high' &&
      Math.abs(e.ts.getTime() - ctx.barTs.getTime()) <= windowMs &&
      e.currencies.some((c) => currencies.includes(c)),
  );
  return hit
    ? {
        pass: false,
        reasonCode: 'ECON_BLACKOUT',
        detail: `high-impact event (${hit.currencies.join('/')}) at ${hit.ts.toISOString()} within ±${config.blackoutMinutes}min`,
      }
    : { pass: true, detail: `no high-impact event within ±${config.blackoutMinutes}min` };
}

function weekendGapRule(
  ctx: RiskGateContext,
  config: RiskGateConfig,
  flags: RiskFlag[],
): RuleCheck {
  // Prefer the Python feature (QN-047); fall back to the engine's own
  // DST-aware computation when absent (both are tested against DST fixtures).
  const inWindow =
    ctx.weekendGapWindow ?? inFridayPreCloseWindow(ctx.barTs, config.weekendGapWindowHours);
  const highVol = ctx.liquidityRegime === 'LOW';
  if (!inWindow) return { pass: true, detail: 'outside Friday pre-close window' };
  if (!config.weekendFlattenEnabled) {
    return { pass: true, detail: 'in Friday pre-close window; weekend flatten disabled' };
  }
  if (!highVol) {
    return { pass: true, detail: 'in Friday pre-close window; regime not high-vol' };
  }
  // High-vol + window + flatten enabled: flag existing positions, veto entry.
  if (ctx.openPositions.length > 0) {
    flags.push({
      flag: 'WEEKEND_GAP_FLATTEN',
      detail: `pre-close flatten: [${ctx.openPositions.map((p) => p.instrument).join(', ')}]`,
    });
  }
  return {
    pass: false,
    reasonCode: 'WEEKEND_GAP_WINDOW',
    detail: 'high-vol regime inside Friday pre-close window — no new entries',
  };
}

function rolloverRule(ctx: RiskGateContext, config: RiskGateConfig, flags: RiskFlag[]): RuleCheck {
  const warned: string[] = [];
  for (const pos of ctx.openPositions) {
    if (tripleSwapWarning(pos.openedAt, ctx.barTs)) {
      warned.push(pos.instrument);
      flags.push({
        flag: 'TRIPLE_SWAP_WARNING',
        detail: `${pos.instrument} held >2 days crossing Wednesday 17:00 NY rollover`,
      });
      if (pos.instrument === 'XAU_USD' && config.rolloverAutoFlattenXau) {
        flags.push({
          flag: 'ROLLOVER_AUTOFLATTEN_XAU',
          detail: 'XAU_USD auto-flatten configured for triple-swap rollover',
        });
      }
    }
  }
  return {
    pass: true, // advisory rule — never vetoes the new entry
    detail: warned.length > 0 ? `triple-swap warnings: ${warned.join(', ')}` : 'no rollover flags',
  };
}
