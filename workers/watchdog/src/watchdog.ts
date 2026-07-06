/** BE-053 — watchdog core, extracted from index.ts so trigger timing,
 * degraded handling, and re-arm behavior are unit-testable with injected
 * heartbeat/flatten/alert functions. */

export type HeartbeatState = 'ok' | 'degraded' | 'down';

export interface WatchdogDeps {
  /** Poll the platform heartbeat and classify it. */
  pollHeartbeat: () => Promise<HeartbeatState>;
  /** Flatten all open positions via OANDA REST (throws until confirmed flat). */
  flatten: () => Promise<void>;
  /** Critical operator alert (Telegram + SMS). */
  alert: (text: string) => Promise<void>;
  /** Misses (down heartbeats) before triggering the flatten. */
  timeoutMisses: number;
  /** Backoff between flatten retries; injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

export class Watchdog {
  private consecutiveMisses = 0;
  private triggered = false;
  private degradedAlerted = false;

  constructor(private readonly deps: WatchdogDeps) {}

  /** One poll cycle. Returns the observed heartbeat state (for logging). */
  async tick(): Promise<HeartbeatState> {
    const state = await this.deps.pollHeartbeat();

    if (state === 'ok') {
      // Healthy again → reset the miss counter AND re-arm the trigger, so a
      // recovered host that dies a second time is still protected.
      this.consecutiveMisses = 0;
      this.triggered = false;
      this.degradedAlerted = false;
      return state;
    }

    if (state === 'degraded') {
      // API up but execution worker silent (>120s): positions are unmanaged
      // but broker-side SL/TP still stand — alert loudly, don't flatten.
      // Full-host unreachability is what triggers the flatten.
      this.consecutiveMisses = 0;
      if (!this.degradedAlerted) {
        this.degradedAlerted = true;
        await this.deps.alert(
          'Watchdog: platform heartbeat DEGRADED (execution worker silent) — positions unmanaged, investigate now',
        );
      }
      return state;
    }

    this.consecutiveMisses += 1;
    console.warn(`heartbeat miss ${this.consecutiveMisses}/${this.deps.timeoutMisses}`);
    if (this.consecutiveMisses >= this.deps.timeoutMisses && !this.triggered) {
      this.triggered = true;
      await this.runFlatten(`${this.consecutiveMisses} consecutive heartbeat failures`);
    }
    return state;
  }

  /** Retry-with-backoff until the broker confirms flat. */
  private async runFlatten(reason: string): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    await this.deps.alert(`Watchdog triggered: ${reason}`);
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        await this.deps.flatten();
        await this.deps.alert(`Watchdog flatten confirmed (attempt ${attempt})`);
        return;
      } catch (err) {
        await this.deps.alert(`Watchdog flatten retry ${attempt}: ${err}`);
        await sleep(Math.min(30_000, 2 ** attempt * 1000));
      }
    }
  }
}

/** Classify a heartbeat HTTP response body. Exposed for tests. */
export function classifyHeartbeat(ok: boolean, body: { status?: string } | null): HeartbeatState {
  if (!ok || !body) return 'down';
  if (body.status === 'ok') return 'ok';
  if (body.status === 'degraded') return 'degraded';
  return 'down';
}
