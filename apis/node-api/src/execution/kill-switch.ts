import type { Redis } from 'ioredis';
import { EXECUTION_HALT_KEY, setExecutionHalt } from './halt.js';

/**
 * BE-073 — kill-switch state persistence (ADR-012).
 *
 * POSTGRES IS THE SOURCE OF TRUTH; the Redis flag is a fast-path cache
 * ONLY. Every read that misses the cache re-hydrates from Postgres before
 * answering, so a Redis flush/restart can never silently clear the most
 * safety-critical flag in the system (chaos-tested in BE-120).
 *
 * State machine per activation row:
 *   active=true, closeOutStatus='closing'  → close-out running/retrying
 *   active=true, closeOutStatus='flat'     → broker-confirmed flat
 *   active=true, closeOutStatus='failed'   → manual intervention needed
 *                                            (reconciler BE-052 is backstop)
 *   active=false (deactivatedAt set)       → switch released by operator
 *
 * The reported status is CLOSING (never CLOSED) until broker-confirmed flat.
 */

/** Redis fast-path cache: '1' active, '0' inactive, absent = cache miss. */
export const KILL_SWITCH_REDIS_KEY = 'kill-switch:active';

/** Reason prefix lets deactivate() know the halt flag was ours to clear. */
export const KILL_SWITCH_HALT_REASON_PREFIX = 'kill-switch:';

export type CloseOutStatus = 'closing' | 'flat' | 'failed';

export interface KillSwitchRow {
  id: string;
  active: boolean;
  reason: string;
  activatedBy: string;
  activatedAt: Date;
  deactivatedBy: string | null;
  deactivatedAt: Date | null;
  closeOutStatus: string | null;
  closeReport: unknown;
  updatedAt: Date;
}

/** Structural seam over the generated Prisma delegate (typechecks pre-generate). */
export interface KillSwitchDb {
  killSwitchState: {
    create(args: {
      data: { active: boolean; reason: string; activatedBy: string; closeOutStatus: string };
    }): Promise<KillSwitchRow>;
    findFirst(args: { orderBy: { activatedAt: 'desc' } }): Promise<KillSwitchRow | null>;
    update(args: {
      where: { id: string };
      data: Partial<{
        active: boolean;
        deactivatedBy: string;
        deactivatedAt: Date;
        closeOutStatus: string;
        closeReport: unknown;
      }>;
    }): Promise<KillSwitchRow>;
  };
}

export class KillSwitchStore {
  constructor(
    private readonly db: KillSwitchDb,
    private readonly redis: Redis,
  ) {}

  /**
   * Fast-path read with mandatory Postgres re-hydration on cache miss —
   * the BE-073 contract every worker calls before processing a job.
   */
  async isActive(): Promise<boolean> {
    const cached = await this.redis.get(KILL_SWITCH_REDIS_KEY);
    if (cached === '1') return true;
    if (cached === '0') return false;
    return this.hydrate();
  }

  /** Read Postgres (source of truth) and repopulate the Redis cache. */
  async hydrate(): Promise<boolean> {
    const row = await this.db.killSwitchState.findFirst({ orderBy: { activatedAt: 'desc' } });
    const active = row?.active === true;
    await this.redis.set(KILL_SWITCH_REDIS_KEY, active ? '1' : '0');
    return active;
  }

  async current(): Promise<KillSwitchRow | null> {
    return this.db.killSwitchState.findFirst({ orderBy: { activatedAt: 'desc' } });
  }

  /**
   * BE-072 step 1 — persist the activation. Write order is deliberate:
   * Postgres FIRST (source of truth), then the Redis cache, then the sticky
   * execution-halt flag every worker already checks. If Redis dies between
   * writes the next cache miss re-hydrates to ACTIVE — never the reverse.
   */
  async activate(by: string, reason: string): Promise<KillSwitchRow> {
    const row = await this.db.killSwitchState.create({
      data: { active: true, reason, activatedBy: by, closeOutStatus: 'closing' },
    });
    await this.redis.set(KILL_SWITCH_REDIS_KEY, '1');
    await setExecutionHalt(this.redis, `${KILL_SWITCH_HALT_REASON_PREFIX}${reason}`);
    return row;
  }

  async recordCloseOut(id: string, status: CloseOutStatus, report: unknown): Promise<void> {
    await this.db.killSwitchState.update({
      where: { id },
      data: { closeOutStatus: status, closeReport: report },
    });
  }

  /**
   * Release the switch. Clears the halt flag only if the kill-switch set it
   * (a reconciler-set halt survives — it has its own manual-clear contract).
   */
  async deactivate(by: string): Promise<KillSwitchRow | null> {
    const row = await this.db.killSwitchState.findFirst({ orderBy: { activatedAt: 'desc' } });
    if (!row?.active) return null;
    const updated = await this.db.killSwitchState.update({
      where: { id: row.id },
      data: { active: false, deactivatedBy: by, deactivatedAt: new Date() },
    });
    await this.redis.set(KILL_SWITCH_REDIS_KEY, '0');
    const haltReason = await this.redis.get(`${EXECUTION_HALT_KEY}:reason`);
    if (haltReason?.startsWith(KILL_SWITCH_HALT_REASON_PREFIX)) {
      await this.redis.del(EXECUTION_HALT_KEY, `${EXECUTION_HALT_KEY}:reason`);
    }
    return updated;
  }
}

// ─── BE-072 — close-out executor (<2s target, partial-failure handling) ─────

export interface CloseOutQuantClient {
  listOpenPositions(): Promise<Array<{ instrument: string; brokerTradeIds: string[] }>>;
  closeTrade(
    brokerTradeId: string,
    units?: number,
  ): Promise<{ status: string; reasonCode: string | null }>;
}

export interface CloseAttempt {
  brokerTradeId: string;
  instrument: string;
  attempts: number;
  status: 'closed' | 'failed';
  lastError: string | null;
}

export interface CloseOutReport {
  pendingIntentsCancelled: number;
  positionsSeen: number;
  closes: CloseAttempt[];
  /** True only when a post-close re-list shows the broker flat. */
  brokerConfirmedFlat: boolean;
  status: CloseOutStatus;
  elapsedMs: number;
}

export interface CloseOutDeps {
  quant: CloseOutQuantClient;
  /** Cancel every still-pending TradeIntent; returns how many were cancelled. */
  cancelPendingIntents(): Promise<number>;
  /** Escalating operator alerts (Telegram/SMS seam via notifications queue). */
  alert(severity: 'warning' | 'critical', title: string, body: string): Promise<void>;
  maxAttemptsPerTrade?: number;
}

/**
 * Cancel all pending, close all open, broker-confirm flat.
 *
 * Partial-failure contract (story AC): a rejected/partial close retries with
 * escalating alerts; the returned status stays 'closing' (NEVER 'flat')
 * until a re-list confirms the broker is flat. The 60s reconciler (BE-052)
 * is the backstop for anything still open after our attempts.
 */
export async function executeKillSwitchCloseOut(deps: CloseOutDeps): Promise<CloseOutReport> {
  const started = Date.now();
  const maxAttempts = deps.maxAttemptsPerTrade ?? 3;

  const pendingIntentsCancelled = await deps.cancelPendingIntents();

  let positions: Array<{ instrument: string; brokerTradeIds: string[] }> = [];
  let listFailed: string | null = null;
  try {
    positions = await deps.quant.listOpenPositions();
  } catch (err) {
    listFailed = err instanceof Error ? err.message : String(err);
  }
  if (listFailed !== null) {
    await deps.alert(
      'critical',
      'Kill-switch: cannot list broker positions',
      `ListOpenPositions failed (${listFailed}) — state stays CLOSING; reconciler is the backstop.`,
    );
    return {
      pendingIntentsCancelled,
      positionsSeen: 0,
      closes: [],
      brokerConfirmedFlat: false,
      status: 'closing',
      elapsedMs: Date.now() - started,
    };
  }

  const closes: CloseAttempt[] = [];
  for (const pos of positions) {
    for (const tradeId of pos.brokerTradeIds) {
      const attempt: CloseAttempt = {
        brokerTradeId: tradeId,
        instrument: pos.instrument,
        attempts: 0,
        status: 'failed',
        lastError: null,
      };
      for (let i = 1; i <= maxAttempts; i += 1) {
        attempt.attempts = i;
        try {
          const res = await deps.quant.closeTrade(tradeId);
          if (res.status === 'FILLED') {
            attempt.status = 'closed';
            attempt.lastError = null;
            break;
          }
          attempt.lastError = `close ${res.status}${res.reasonCode ? ` (${res.reasonCode})` : ''}`;
        } catch (err) {
          attempt.lastError = err instanceof Error ? err.message : String(err);
        }
        // Escalating alerts: warning on first failure, critical after that.
        await deps.alert(
          i === 1 ? 'warning' : 'critical',
          `Kill-switch close attempt ${i}/${maxAttempts} failed`,
          `${pos.instrument} trade ${tradeId}: ${attempt.lastError}`,
        );
      }
      closes.push(attempt);
    }
  }

  // Broker-confirm: state is CLOSING until a re-list shows flat (ADR-012).
  let brokerConfirmedFlat = false;
  try {
    const after = await deps.quant.listOpenPositions();
    brokerConfirmedFlat = after.length === 0;
  } catch {
    brokerConfirmedFlat = false; // can't confirm ⇒ stays CLOSING
  }

  const anyFailed = closes.some((c) => c.status === 'failed');
  if (anyFailed) {
    await deps.alert(
      'critical',
      'Kill-switch close-out INCOMPLETE — manual intervention',
      closes
        .filter((c) => c.status === 'failed')
        .map((c) => `${c.instrument} ${c.brokerTradeId}: ${c.lastError}`)
        .join('; '),
    );
  }

  return {
    pendingIntentsCancelled,
    positionsSeen: positions.length,
    closes,
    brokerConfirmedFlat,
    status: brokerConfirmedFlat ? 'flat' : anyFailed ? 'failed' : 'closing',
    elapsedMs: Date.now() - started,
  };
}
