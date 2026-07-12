import { describe, expect, it } from 'vitest';
import { EXECUTION_HALT_KEY, isExecutionHalted } from './halt.js';
import {
  type CloseOutQuantClient,
  executeKillSwitchCloseOut,
  KILL_SWITCH_REDIS_KEY,
  type KillSwitchDb,
  type KillSwitchRow,
  KillSwitchStore,
} from './kill-switch.js';
import { fakeRedis } from './test-fakes.js';

/**
 * BE-072/073 — kill-switch state persistence (ADR-012) + close-out
 * partial-failure handling. The critical property under test: POSTGRES IS
 * THE SOURCE OF TRUTH — a Redis flush while the switch is active must NEVER
 * silently resume trading (workers re-hydrate on cache miss).
 */

function fakeDb(): { db: KillSwitchDb; rows: KillSwitchRow[] } {
  const rows: KillSwitchRow[] = [];
  let seq = 0;
  const db: KillSwitchDb = {
    killSwitchState: {
      async create({ data }) {
        seq += 1;
        const row: KillSwitchRow = {
          id: `ks-${seq}`,
          active: data.active,
          reason: data.reason,
          activatedBy: data.activatedBy,
          activatedAt: new Date(Date.now() + seq), // strictly increasing
          deactivatedBy: null,
          deactivatedAt: null,
          closeOutStatus: data.closeOutStatus,
          closeReport: null,
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      async findFirst() {
        const sorted = [...rows].sort((a, b) => +b.activatedAt - +a.activatedAt);
        return sorted[0] ?? null;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error(`no row ${where.id}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
  };
  return { db, rows };
}

describe('KillSwitchStore (BE-073, ADR-012)', () => {
  it('activate: Postgres row first, then Redis cache, then execution halt flag', async () => {
    const rig = fakeRedis();
    const { db, rows } = fakeDb();
    const store = new KillSwitchStore(db, rig.redis);

    const row = await store.activate('operator-1', 'flash crash');

    expect(rows).toHaveLength(1);
    expect(row.active).toBe(true);
    expect(row.closeOutStatus).toBe('closing');
    expect(rig.store.get(KILL_SWITCH_REDIS_KEY)).toBe('1');
    expect(await isExecutionHalted(rig.redis)).toBe(true); // workers pause NOW
    expect(await store.isActive()).toBe(true);
  });

  it('REDIS FLUSHED while active ⇒ re-hydrates from Postgres, stays halted (story AC)', async () => {
    const rig = fakeRedis();
    const { db } = fakeDb();
    const store = new KillSwitchStore(db, rig.redis);
    await store.activate('operator-1', 'test');

    rig.store.clear(); // simulate Redis restart/flush — cache AND halt flag gone

    expect(await store.isActive()).toBe(true); // Postgres re-hydration
    expect(rig.store.get(KILL_SWITCH_REDIS_KEY)).toBe('1'); // cache repopulated
  });

  it('cache miss with no Postgres rows hydrates to inactive', async () => {
    const rig = fakeRedis();
    const store = new KillSwitchStore(fakeDb().db, rig.redis);
    expect(await store.isActive()).toBe(false);
    expect(rig.store.get(KILL_SWITCH_REDIS_KEY)).toBe('0');
  });

  it('deactivate clears the cache and the kill-switch-owned halt flag', async () => {
    const rig = fakeRedis();
    const { db } = fakeDb();
    const store = new KillSwitchStore(db, rig.redis);
    await store.activate('op', 'why');

    const released = await store.deactivate('op-2');

    expect(released?.active).toBe(false);
    expect(released?.deactivatedBy).toBe('op-2');
    expect(await store.isActive()).toBe(false);
    expect(await isExecutionHalted(rig.redis)).toBe(false);
  });

  it('deactivate does NOT clear a reconciler-set halt (different owner)', async () => {
    const rig = fakeRedis();
    const { db } = fakeDb();
    const store = new KillSwitchStore(db, rig.redis);
    await store.activate('op', 'why');
    // Reconciler overwrote the reason with its own sticky halt.
    await rig.redis.set(EXECUTION_HALT_KEY, '1');
    await rig.redis.set(`${EXECUTION_HALT_KEY}:reason`, 'reconciliation mismatch');

    await store.deactivate('op');

    expect(await store.isActive()).toBe(false); // switch itself released
    expect(await isExecutionHalted(rig.redis)).toBe(true); // reconciler halt survives
  });

  it('deactivate when not active returns null', async () => {
    const store = new KillSwitchStore(fakeDb().db, fakeRedis().redis);
    expect(await store.deactivate('op')).toBeNull();
  });

  it('recordCloseOut mutates the activation row (history retained)', async () => {
    const rig = fakeRedis();
    const { db, rows } = fakeDb();
    const store = new KillSwitchStore(db, rig.redis);
    const row = await store.activate('op', 'why');
    await store.recordCloseOut(row.id, 'flat', { closes: [] });
    expect(rows[0]?.closeOutStatus).toBe('flat');
  });
});

// ─── close-out executor (BE-072) ─────────────────────────────────────────────

interface QuantScript {
  lists: Array<Array<{ instrument: string; brokerTradeIds: string[] }>>;
  closeResults: Record<string, Array<{ status: string; reasonCode: string | null }>>;
}

function scriptedQuant(script: QuantScript): {
  quant: CloseOutQuantClient;
  closeCalls: string[];
} {
  const closeCalls: string[] = [];
  let listCall = 0;
  const attempts: Record<string, number> = {};
  return {
    closeCalls,
    quant: {
      async listOpenPositions() {
        const res = script.lists[Math.min(listCall, script.lists.length - 1)];
        listCall += 1;
        if (res === undefined) throw new Error('list failed');
        return res;
      },
      async closeTrade(id: string) {
        closeCalls.push(id);
        const n = attempts[id] ?? 0;
        attempts[id] = n + 1;
        const seq = script.closeResults[id] ?? [{ status: 'FILLED', reasonCode: null }];
        return seq[Math.min(n, seq.length - 1)] ?? { status: 'FILLED', reasonCode: null };
      },
    },
  };
}

function alertCollector() {
  const alerts: Array<{ severity: string; title: string }> = [];
  return {
    alerts,
    alert: async (severity: 'warning' | 'critical', title: string, _body: string) => {
      alerts.push({ severity, title });
    },
  };
}

describe('executeKillSwitchCloseOut (BE-072)', () => {
  it('happy path: cancels pending, closes all, broker-confirms flat, fast', async () => {
    const { quant, closeCalls } = scriptedQuant({
      lists: [
        [
          { instrument: 'EUR_USD', brokerTradeIds: ['t1'] },
          { instrument: 'XAU_USD', brokerTradeIds: ['t2', 't3'] },
        ],
        [], // re-list after closes: flat
      ],
      closeResults: {},
    });
    const { alerts, alert } = alertCollector();

    const report = await executeKillSwitchCloseOut({
      quant,
      cancelPendingIntents: async () => 2,
      alert,
    });

    expect(report.pendingIntentsCancelled).toBe(2);
    expect(closeCalls).toEqual(['t1', 't2', 't3']);
    expect(report.brokerConfirmedFlat).toBe(true);
    expect(report.status).toBe('flat');
    expect(report.elapsedMs).toBeLessThan(2_000); // <2s AC (no broker latency here)
    expect(alerts).toHaveLength(0);
  });

  it('rejected close retries with ESCALATING alerts; reports CLOSING/FAILED never flat (story AC)', async () => {
    const { quant } = scriptedQuant({
      lists: [
        [{ instrument: 'EUR_USD', brokerTradeIds: ['t1'] }],
        [{ instrument: 'EUR_USD', brokerTradeIds: ['t1'] }], // still open after attempts
      ],
      closeResults: {
        t1: [
          { status: 'REJECTED', reasonCode: 'MARKET_HALTED' },
          { status: 'REJECTED', reasonCode: 'MARKET_HALTED' },
          { status: 'REJECTED', reasonCode: 'MARKET_HALTED' },
        ],
      },
    });
    const { alerts, alert } = alertCollector();

    const report = await executeKillSwitchCloseOut({
      quant,
      cancelPendingIntents: async () => 0,
      alert,
    });

    const failed = report.closes[0];
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(3);
    expect(report.brokerConfirmedFlat).toBe(false);
    expect(report.status).toBe('failed'); // manual intervention; reconciler backstop
    // Escalation: warning first, critical after.
    expect(alerts[0]?.severity).toBe('warning');
    expect(alerts.slice(1).every((a) => a.severity === 'critical')).toBe(true);
  });

  it('close eventually fills on retry ⇒ flat once re-list confirms', async () => {
    const { quant } = scriptedQuant({
      lists: [[{ instrument: 'EUR_USD', brokerTradeIds: ['t1'] }], []],
      closeResults: {
        t1: [
          { status: 'REJECTED', reasonCode: 'PRICE_MOVED' },
          { status: 'FILLED', reasonCode: null },
        ],
      },
    });
    const { alerts, alert } = alertCollector();

    const report = await executeKillSwitchCloseOut({
      quant,
      cancelPendingIntents: async () => 0,
      alert,
    });

    expect(report.closes[0]?.status).toBe('closed');
    expect(report.closes[0]?.attempts).toBe(2);
    expect(report.status).toBe('flat');
    expect(alerts).toHaveLength(1); // the single warning from attempt 1
  });

  it('cannot list broker positions ⇒ critical alert, state stays CLOSING', async () => {
    const quant: CloseOutQuantClient = {
      listOpenPositions: async () => {
        throw new Error('grpc unavailable');
      },
      closeTrade: async () => ({ status: 'FILLED', reasonCode: null }),
    };
    const { alerts, alert } = alertCollector();

    const report = await executeKillSwitchCloseOut({
      quant,
      cancelPendingIntents: async () => 1,
      alert,
    });

    expect(report.status).toBe('closing'); // NEVER flat without broker confirm
    expect(report.brokerConfirmedFlat).toBe(false);
    expect(alerts[0]?.severity).toBe('critical');
  });
});
