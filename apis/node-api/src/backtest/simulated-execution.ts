import type { TradeSide } from '@fx/types';

/**
 * QN-056 — deterministic simulated execution for the agentic runner.
 *
 * Fill + cost semantics are a LINE-FOR-LINE mirror of the Python engine
 * (services/quant/app/backtest/engine.py + costs.py): entry at bar close,
 * first-touch bracket with the conservative SL-first tie-break, gap-through
 * fills at the OPEN (loss beyond stop), stop-exit slippage (10× on flash
 * bars), per-rollover financing with Wednesday triple swap, horizon expiry.
 * That parity is what makes the QN-056 quant-only ⇄ QN-050 reconciliation a
 * meaningful correctness cross-check — change BOTH files or neither.
 */

// ── cost tables (mirror app/backtest/costs.py) ───────────────────────────────

export const DEFAULT_SPREAD_PIPS: Record<string, number> = {
  EUR_USD: 0.8,
  GBP_USD: 1.2,
  USD_JPY: 0.9,
  USD_CHF: 1.4,
  USD_CAD: 1.6,
  AUD_USD: 1.1,
  NZD_USD: 1.6,
  XAU_USD: 3.5,
  WTICO_USD: 4.0,
  BCO_USD: 4.0,
};
export const FALLBACK_SPREAD_PIPS = 2.0;
const OFF_HOURS_SPREAD_MULT = 1.5;

export function pipSize(instrument: string): number {
  if (instrument.endsWith('_JPY')) return 0.01;
  if (/^(XAU|XAG|WTICO|BCO)/.test(instrument)) return 0.01;
  return 0.0001;
}

export function effectiveSpreadPips(
  instrument: string,
  observed: number | null,
  sessionLabel: string,
): number {
  if (observed !== null && observed > 0) return observed;
  const base = DEFAULT_SPREAD_PIPS[instrument] ?? FALLBACK_SPREAD_PIPS;
  const mult = sessionLabel === 'OFF_HOURS' || sessionLabel === 'TOKYO' ? OFF_HOURS_SPREAD_MULT : 1;
  return base * mult;
}

export interface CostParams {
  stopSlippageFrac: number;
  flashPctile: number;
  flashSlippageMult: number;
  financingPipsPerDay: number;
}

export const DEFAULT_COST_PARAMS: CostParams = {
  stopSlippageFrac: 0.5,
  flashPctile: 0.99,
  flashSlippageMult: 10,
  financingPipsPerDay: 0.6,
};

// ── DST-aware rollover counting (17:00 America/New_York) ────────────────────

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
});

function nyHourAndWeekday(d: Date): { hour: number; weekday: number } {
  const parts = NY_FMT.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
  return { hour, weekday };
}

/** Financing days over (openTs, closeTs]: 1 per 17:00-NY crossing, 3 on Wednesday. */
export function financingDays(
  openTs: Date,
  closeTs: Date,
): { days: number; crossings: number; triples: number } {
  let days = 0;
  let crossings = 0;
  let triples = 0;
  // Hourly walk — bars are H1 and NY offsets are whole hours, so a crossing
  // is exactly one hourly step whose NY hour becomes 17.
  for (let t = openTs.getTime() + 3_600_000; t <= closeTs.getTime(); t += 3_600_000) {
    const { hour, weekday } = nyHourAndWeekday(new Date(t));
    if (hour === 17) {
      crossings += 1;
      if (weekday === 3) {
        triples += 1;
        days += 3;
      } else {
        days += 1;
      }
    }
  }
  return { days, crossings, triples };
}

// ── bar + trade shapes ───────────────────────────────────────────────────────

export interface SimBar {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  sessionLabel: string;
  spreadPips: number | null;
  spreadPctile: number | null;
}

export interface OpenPosition {
  signalId: string;
  instrument: string;
  side: TradeSide;
  entryTs: Date;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  units: number;
  riskDistance: number;
  probability: number;
  barsHeld: number;
  /** Round-trip spread charged once, resolved at ENTRY (engine parity). */
  entrySpreadPips: number;
}

export interface ClosedTrade {
  signalId: string;
  instrument: string;
  side: TradeSide;
  entryTs: string;
  exitTs: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: 'SL' | 'TP' | 'GAP_SL' | 'EXPIRY' | 'END';
  probability: number;
  grossPips: number;
  costs: {
    spreadPips: number;
    slippagePips: number;
    swapPips: number;
    gapExcessPips: number;
    flashEvent: boolean;
  };
  netPips: number;
  rMultiple: number;
  pnl: number;
}

/**
 * Advance one open position through one bar. Returns the closed trade when an
 * exit fired, else null (position stays open, barsHeld incremented).
 */
export function stepPosition(
  pos: OpenPosition,
  bar: SimBar,
  horizonBars: number,
  costs: CostParams,
  isFinalBar: boolean,
): ClosedTrade | null {
  const s = pos.side === 'long' ? 1 : -1;
  let exitPrice: number | null = null;
  let exitReason: ClosedTrade['exitReason'] | null = null;
  let gapExcess = 0;

  const gapThrough = s > 0 ? bar.open <= pos.stopLoss : bar.open >= pos.stopLoss;
  if (gapThrough) {
    exitPrice = bar.open;
    exitReason = 'GAP_SL';
    gapExcess = Math.abs(pos.stopLoss - bar.open) / pipSize(pos.instrument);
  } else {
    const hitSl = s > 0 ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss;
    const hitTp = s > 0 ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit;
    if (hitSl) {
      exitPrice = pos.stopLoss;
      exitReason = 'SL'; // conservative tie-break: SL first (labels.py rule)
    } else if (hitTp) {
      exitPrice = pos.takeProfit;
      exitReason = 'TP';
    } else if (pos.barsHeld + 1 >= horizonBars) {
      exitPrice = bar.close;
      exitReason = 'EXPIRY';
    } else if (isFinalBar) {
      exitPrice = bar.close;
      exitReason = 'END';
    }
  }

  if (exitPrice === null || exitReason === null) {
    pos.barsHeld += 1;
    return null;
  }

  const pip = pipSize(pos.instrument);
  const spreadEntry = pos.entrySpreadPips;
  let slippage = 0;
  let flash = false;
  if (exitReason === 'SL' || exitReason === 'GAP_SL') {
    const spreadNow = effectiveSpreadPips(pos.instrument, bar.spreadPips, bar.sessionLabel);
    flash = bar.spreadPctile !== null && bar.spreadPctile >= costs.flashPctile;
    slippage = spreadNow * costs.stopSlippageFrac * (flash ? costs.flashSlippageMult : 1);
  }
  const { days } = financingDays(pos.entryTs, bar.ts);
  const swap = days * costs.financingPipsPerDay;

  const grossPips = ((exitPrice - pos.entryPrice) / pip) * s;
  const totalCostPips = spreadEntry + slippage + swap; // gap excess already in gross
  const netPips = grossPips - totalCostPips;
  const riskPips = pos.riskDistance / pip;
  const rMultiple = riskPips > 0 ? netPips / riskPips : 0;
  const pnl = netPips * pip * pos.units;

  return {
    signalId: pos.signalId,
    instrument: pos.instrument,
    side: pos.side,
    entryTs: pos.entryTs.toISOString(),
    exitTs: bar.ts.toISOString(),
    entryPrice: pos.entryPrice,
    exitPrice,
    exitReason,
    probability: pos.probability,
    grossPips,
    costs: {
      spreadPips: spreadEntry,
      slippagePips: slippage,
      swapPips: swap,
      gapExcessPips: gapExcess,
      flashEvent: flash,
    },
    netPips,
    rMultiple,
    pnl,
  };
}
