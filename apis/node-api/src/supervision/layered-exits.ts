import type { TradeSide } from '@fx/types';

/**
 * BE-081 — layered exit system (Phase 4, Step 4.1).
 *
 * Five INDEPENDENT deterministic exit layers over one open trade; any single
 * trigger closes (or flattens) — FIRST-TO-FIRE WINS, evaluated in fixed
 * priority order:
 *
 *   1. hard_sl_tp        — code backstop for the broker bracket: price at/
 *                          beyond SL or TP (covers a broker bracket that was
 *                          rejected or drifted; normally the broker fires first).
 *   2. dd_halt           — account daily-loss halt (§10, 5% default): flatten,
 *                          regardless of this trade's own P&L.
 *   3. pre_news_flatten  — high-impact calendar event inside the blackout
 *                          window for this instrument. Calendar unavailable ⇒
 *                          recorded as 'calendar_unavailable', NO exit (same
 *                          policy as the entry risk gate — Phase-3 seam).
 *   4. time_stop         — held longer than the max holding period (H1 swing
 *                          trades should resolve; stale trades tie up risk).
 *   5. atr_trail         — code backstop for the BE-051 trailed stop: price
 *                          crossed the last trailed SL level (`meta.lastTrailSl`).
 *
 * Every layer is a pure function of `ExitContext` — no I/O, no clock reads —
 * so each is unit-testable in isolation (story AC). The worker performs the
 * actual close via the same gRPC execution channel the kill-switch uses.
 */

export type ExitLayer = 'hard_sl_tp' | 'dd_halt' | 'pre_news_flatten' | 'time_stop' | 'atr_trail';

export interface ExitDecision {
  exit: true;
  layer: ExitLayer;
  /** close = this trade only; flatten_all = account-level halt (dd_halt). */
  scope: 'close' | 'flatten_all';
  detail: string;
}

export interface ExitContext {
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** BE-051 trailed stop level from trade.meta (null until trail activates). */
  lastTrailSl: number | null;
  openedAt: Date;
  /** Evaluation instant (injected — never Date.now() inside the layers). */
  now: Date;
  /** Account equity and realized P&L today (dd_halt inputs). */
  equity: number;
  dailyRealizedPnl: number;
  /** Calendar seam (mirrors the risk-gate policy). */
  calendarAvailable: boolean;
  highImpactEventWithinBlackout: boolean;
  config: ExitConfig;
}

export interface ExitConfig {
  /** Daily-loss flatten threshold as a fraction of equity (default 0.05). */
  dailyDrawdownHaltPct: number;
  /** Max holding period in hours (default 72 = 3 trading days on H1). */
  timeStopHours: number;
  /** Calendar blackout — informational here; the caller resolves the window. */
  newsBlackoutMinutes: number;
}

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  dailyDrawdownHaltPct: 0.05,
  timeStopHours: 72,
  newsBlackoutMinutes: 30,
};

type LayerResult = ExitDecision | { exit: false; note?: string };

const NO_EXIT: LayerResult = { exit: false };

/** Layer 1 — hard SL/TP backstop. */
export function hardStopLayer(ctx: ExitContext): LayerResult {
  const { side, currentPrice, stopLoss, takeProfit } = ctx;
  if (stopLoss !== null) {
    const hit = side === 'long' ? currentPrice <= stopLoss : currentPrice >= stopLoss;
    if (hit) {
      return {
        exit: true,
        layer: 'hard_sl_tp',
        scope: 'close',
        detail: `price ${currentPrice} beyond stop ${stopLoss} (${side})`,
      };
    }
  }
  if (takeProfit !== null) {
    const hit = side === 'long' ? currentPrice >= takeProfit : currentPrice <= takeProfit;
    if (hit) {
      return {
        exit: true,
        layer: 'hard_sl_tp',
        scope: 'close',
        detail: `price ${currentPrice} beyond target ${takeProfit} (${side})`,
      };
    }
  }
  return NO_EXIT;
}

/** Layer 2 — account daily-loss halt (flatten everything). */
export function ddHaltLayer(ctx: ExitContext): LayerResult {
  const equity = ctx.equity > 0 ? ctx.equity : 1;
  const lossPct = Math.max(0, -ctx.dailyRealizedPnl) / equity;
  if (lossPct >= ctx.config.dailyDrawdownHaltPct) {
    return {
      exit: true,
      layer: 'dd_halt',
      scope: 'flatten_all',
      detail: `daily realized loss ${(lossPct * 100).toFixed(2)}% >= halt ${(ctx.config.dailyDrawdownHaltPct * 100).toFixed(2)}%`,
    };
  }
  return NO_EXIT;
}

/** Layer 3 — pre-news flatten (calendar-gated; unavailable ⇒ note, no exit). */
export function preNewsFlattenLayer(ctx: ExitContext): LayerResult {
  if (!ctx.calendarAvailable) {
    return { exit: false, note: 'calendar_unavailable' };
  }
  if (ctx.highImpactEventWithinBlackout) {
    return {
      exit: true,
      layer: 'pre_news_flatten',
      scope: 'close',
      detail: `high-impact event within ${ctx.config.newsBlackoutMinutes}min blackout`,
    };
  }
  return NO_EXIT;
}

/** Layer 4 — time stop. */
export function timeStopLayer(ctx: ExitContext): LayerResult {
  const holdingHours = (ctx.now.getTime() - ctx.openedAt.getTime()) / 3_600_000;
  if (holdingHours >= ctx.config.timeStopHours) {
    return {
      exit: true,
      layer: 'time_stop',
      scope: 'close',
      detail: `held ${holdingHours.toFixed(1)}h >= time stop ${ctx.config.timeStopHours}h`,
    };
  }
  return NO_EXIT;
}

/** Layer 5 — trailed-stop backstop (never fires until BE-051 set a trail). */
export function atrTrailLayer(ctx: ExitContext): LayerResult {
  if (ctx.lastTrailSl === null) return NO_EXIT;
  const crossed =
    ctx.side === 'long' ? ctx.currentPrice <= ctx.lastTrailSl : ctx.currentPrice >= ctx.lastTrailSl;
  if (crossed) {
    return {
      exit: true,
      layer: 'atr_trail',
      scope: 'close',
      detail: `price ${ctx.currentPrice} crossed trailed stop ${ctx.lastTrailSl} (${ctx.side})`,
    };
  }
  return NO_EXIT;
}

/** Fixed evaluation order — the story's "first-to-fire wins". */
export const EXIT_LAYERS: ReadonlyArray<{
  layer: ExitLayer;
  evaluate: (ctx: ExitContext) => LayerResult;
}> = [
  { layer: 'hard_sl_tp', evaluate: hardStopLayer },
  { layer: 'dd_halt', evaluate: ddHaltLayer },
  { layer: 'pre_news_flatten', evaluate: preNewsFlattenLayer },
  { layer: 'time_stop', evaluate: timeStopLayer },
  { layer: 'atr_trail', evaluate: atrTrailLayer },
];

export interface LayeredExitResult {
  decision: ExitDecision | null;
  /** Non-exit notes (e.g. calendar_unavailable) — audited, never silent. */
  notes: string[];
}

/** Evaluate all layers in priority order; first trigger wins. */
export function evaluateExitLayers(ctx: ExitContext): LayeredExitResult {
  const notes: string[] = [];
  for (const { evaluate } of EXIT_LAYERS) {
    const result = evaluate(ctx);
    if (result.exit) return { decision: result, notes };
    if (result.note) notes.push(result.note);
  }
  return { decision: null, notes };
}
