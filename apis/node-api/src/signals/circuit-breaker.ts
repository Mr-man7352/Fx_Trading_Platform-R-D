/**
 * BE-068 — circuit breaker for the Node → Python gRPC boundary.
 *
 * Parameters match system design §2.2 exactly: 3 consecutive failures within
 * a 5-minute window → OPEN for 60s (calls are not attempted at all) →
 * HALF-OPEN probe → close on success, reopen on failure. Success anywhere
 * resets the consecutive-failure count.
 *
 * Deliberately not opossum: the policy is ~60 lines, the §2.2 numbers are
 * contractual, and an injectable clock makes it deterministic under test.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. §2.2: 3. */
  failureThreshold?: number;
  /** Failures only count while within this window. §2.2: 5 min. */
  windowMs?: number;
  /** How long the circuit stays open before a probe. §2.2: 60s. */
  openMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;

  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private probing = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.openMs = options.openMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  state(): CircuitState {
    if (this.openedAt === null) return 'closed';
    if (this.now() - this.openedAt >= this.openMs) return 'half_open';
    return 'open';
  }

  /**
   * True when a call may be attempted. While OPEN this is false (callers
   * return HOLD `CIRCUIT_OPEN` without touching the network). In HALF-OPEN
   * exactly one probe is admitted at a time.
   */
  canAttempt(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    const ts = this.now();
    if (this.openedAt !== null) {
      // Failed probe (or late failure while open) — restart the 60s cooldown.
      this.openedAt = ts;
      this.probing = false;
      return;
    }
    this.failureTimestamps = this.failureTimestamps
      .filter((t) => ts - t <= this.windowMs)
      .concat(ts);
    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.openedAt = ts;
      this.failureTimestamps = [];
    }
  }
}
