import type { DataQualityFlag, DataQualityKind, Timeframe } from '@fx/types';
import { getInstrument, pipSize } from './instruments.js';

/**
 * BE-044 — data-quality monitor: gap, staleness, spread-anomaly and vendor
 * cross-check detection. A `critical` flag marks the instrument `degraded`;
 * `degradedInstruments()` is what the risk gate (BE-070, Phase 3) reads to
 * block new entries. DST-aware session windows are refined by QN-047; the
 * weekend heuristic here just suppresses false gap alerts over the FX close.
 */

/** Where flags go. Default logs; the worker swaps in an EventBus-backed sink. */
export interface DataQualitySink {
  record(flag: DataQualityFlag): void;
}

export interface DataQualityConfig {
  /** No tick for longer than this ⇒ stale feed (QN-020 raises the same 30 s). */
  staleTickMs: number;
  /** Spread above this many pips ⇒ anomaly (warn; 3× ⇒ critical). */
  maxSpreadPips: number;
  /** Gap tolerance: bars may be up to this many intervals apart before a flag. */
  maxMissingBars: number;
}

export const DEFAULT_DQ_CONFIG: DataQualityConfig = {
  staleTickMs: 30_000,
  maxSpreadPips: 8,
  maxMissingBars: 1,
};

const TF_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
};

/** Coarse FX-closed heuristic: Fri 21:00 UTC → Sun 21:00 UTC. */
export function isLikelyMarketClosed(ts: Date): boolean {
  const dow = ts.getUTCDay(); // 0=Sun … 6=Sat
  const hour = ts.getUTCHours();
  if (dow === 6) return true; // Saturday
  if (dow === 0 && hour < 21) return true; // Sunday before reopen
  if (dow === 5 && hour >= 21) return true; // Friday after close
  return false;
}

class LogSink implements DataQualitySink {
  // Default sink logs to console; the worker injects a real one.
  record(flag: DataQualityFlag): void {
    console.warn(
      `[data-quality] ${flag.severity} ${flag.kind} ${flag.instrument}: ${flag.message}`,
    );
  }
}

export class DataQualityMonitor {
  private readonly cfg: DataQualityConfig;
  private readonly sink: DataQualitySink;
  private readonly lastTickAt = new Map<string, number>();
  private readonly lastBarTs = new Map<string, number>();
  /** instrument → active critical flag keeping it degraded. */
  private readonly degraded = new Map<string, DataQualityFlag>();

  constructor(sink: DataQualitySink = new LogSink(), cfg: Partial<DataQualityConfig> = {}) {
    this.cfg = { ...DEFAULT_DQ_CONFIG, ...cfg };
    this.sink = sink;
  }

  /** Record a tick; checks spread and clears any prior stale degradation. */
  observeTick(instrument: string, ts: Date, bid: number, ask: number): void {
    this.lastTickAt.set(instrument, ts.getTime());
    this.clearDegraded(instrument, 'stale');

    const info = getInstrument(instrument);
    if (!info) return;
    const spreadPips = (ask - bid) / pipSize(info);
    if (spreadPips > this.cfg.maxSpreadPips) {
      const critical = spreadPips > this.cfg.maxSpreadPips * 3;
      this.emit({
        kind: 'spread_anomaly',
        severity: critical ? 'critical' : 'warn',
        instrument,
        message: `spread ${spreadPips.toFixed(1)}p exceeds ${this.cfg.maxSpreadPips}p`,
        at: ts.toISOString(),
        degraded: critical,
        meta: { spreadPips },
      });
    }
  }

  /** Detect stale feeds relative to `now`; emits one critical flag per instrument. */
  checkStale(now: Date): void {
    for (const [instrument, last] of this.lastTickAt) {
      const age = now.getTime() - last;
      if (age > this.cfg.staleTickMs && !this.isDegradedBy(instrument, 'stale')) {
        this.emit({
          kind: 'stale',
          severity: 'critical',
          instrument,
          message: `no tick for ${Math.round(age / 1000)}s (>${this.cfg.staleTickMs / 1000}s)`,
          at: now.toISOString(),
          degraded: true,
          meta: { ageMs: age },
        });
      }
    }
  }

  /**
   * Record a closed bar and detect gaps vs the previous bar of the same
   * instrument×timeframe. Contiguous bars clear any prior gap degradation.
   */
  observeBar(instrument: string, timeframe: Timeframe, barTs: Date): void {
    const key = `${instrument}:${timeframe}`;
    const prev = this.lastBarTs.get(key);
    const step = TF_MS[timeframe];
    this.lastBarTs.set(key, barTs.getTime());
    if (prev === undefined) return;

    const missing = Math.round((barTs.getTime() - prev) / step) - 1;
    if (missing > this.cfg.maxMissingBars && !isLikelyMarketClosed(new Date(prev + step))) {
      this.emit({
        kind: 'gap',
        severity: 'critical',
        instrument,
        message: `${missing} missing ${timeframe} bar(s) before ${barTs.toISOString()}`,
        at: barTs.toISOString(),
        degraded: true,
        meta: { missing, timeframe },
      });
    } else {
      this.clearDegraded(instrument, 'gap');
    }
  }

  /** Vendor cross-check discrepancy (QN-021 / BE-041). */
  reportCrossCheck(
    instrument: string,
    at: Date,
    discrepancyPips: number,
    tolerancePips: number,
  ): void {
    if (Math.abs(discrepancyPips) <= tolerancePips) return;
    this.emit({
      kind: 'cross_check',
      severity: 'warn',
      instrument,
      message: `vendor mid differs by ${discrepancyPips.toFixed(1)}p (>${tolerancePips}p)`,
      at: at.toISOString(),
      degraded: false,
      meta: { discrepancyPips, tolerancePips },
    });
  }

  isDegraded(instrument: string): boolean {
    return this.degraded.has(instrument);
  }

  degradedInstruments(): DataQualityFlag[] {
    return [...this.degraded.values()];
  }

  private isDegradedBy(instrument: string, kind: DataQualityKind): boolean {
    return this.degraded.get(instrument)?.kind === kind;
  }

  private clearDegraded(instrument: string, kind: DataQualityKind): void {
    if (this.isDegradedBy(instrument, kind)) this.degraded.delete(instrument);
  }

  private emit(flag: DataQualityFlag): void {
    if (flag.degraded) this.degraded.set(flag.instrument, flag);
    this.sink.record(flag);
  }
}
