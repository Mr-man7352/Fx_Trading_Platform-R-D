/** BE-050 — execution worker behavior tests (idempotency, halt, reject,
 * partial fill, unknown outcome) against in-memory fakes. */

import * as grpc from '@grpc/grpc-js';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { type ExecutionDeps, processExecutionJob } from '../workers/execution.js';
import type { NotificationJob, SupervisionJob } from '../workers/queues.js';
import { EXECUTION_HALT_KEY } from './halt.js';
import {
  type FakeIntent,
  type FakeQuantBehavior,
  fakeEnv,
  fakePrisma,
  fakeQuant,
  fakeQueue,
  fakeRedis,
  filledOrder,
  makeDb,
  wsEvents,
} from './test-fakes.js';

function intentRow(over: Partial<FakeIntent> = {}): FakeIntent {
  return {
    id: 'intent-1',
    instrument: 'EUR_USD',
    side: 'long',
    units: 10_000,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    status: 'approved',
    tradingMode: 'paper',
    ...over,
  };
}

function rig(quantBehavior: FakeQuantBehavior = {}) {
  const db = makeDb();
  const redisRig = fakeRedis();
  const quantRig = fakeQuant(quantBehavior);
  const supervision = fakeQueue<SupervisionJob>();
  const notifications = fakeQueue<NotificationJob>();
  const deps: ExecutionDeps = {
    prisma: fakePrisma(db),
    redis: redisRig.redis,
    quant: quantRig.quant,
    supervisionQueue: supervision.queue,
    notificationsQueue: notifications.queue,
    env: fakeEnv(),
  };
  return { db, redisRig, quantRig, supervision, notifications, deps };
}

const job = (intentId: string) => ({ data: { intentId } }) as Job<{ intentId: string }>;

describe('BE-050 processExecutionJob', () => {
  it('fill: persists trade with broker ids, marks intent executed, enqueues supervision, emits WS', async () => {
    const r = rig();
    r.db.intents.set('intent-1', intentRow());
    await processExecutionJob(r.deps, job('intent-1'));

    const trades = [...r.db.trades.values()];
    expect(trades).toHaveLength(1);
    expect(trades[0]?.brokerTradeId).toBe('bt-1');
    expect(trades[0]?.status).toBe('open');
    expect((trades[0]?.meta as { originalRiskDistance?: number }).originalRiskDistance).toBeCloseTo(
      0.01,
    );
    expect(r.db.intents.get('intent-1')?.status).toBe('executed');
    expect(r.supervision.jobs).toHaveLength(1);
    expect(wsEvents(r.redisRig).map((e) => e.channel)).toContain('trade.fill');
  });

  it('idempotent retry: same intent processed twice → exactly one trade row', async () => {
    const r = rig();
    r.db.intents.set('intent-1', intentRow());
    await processExecutionJob(r.deps, job('intent-1'));
    // Simulate a redelivered job: force the intent back to submitted (as a
    // lost-response retry would see it) — the trade upsert must not duplicate.
    const intent = r.db.intents.get('intent-1');
    if (intent) intent.status = 'submitted';
    await processExecutionJob(r.deps, job('intent-1'));

    expect([...r.db.trades.values()]).toHaveLength(1);
    // The broker-side guarantee (client id duplicate-recovery) is exercised in
    // the Python conformance suite; here we pin the same clientOrderId reuse.
    const placeCalls = r.quantRig.calls.filter((c) => c.method === 'placeOrder');
    expect(placeCalls).toHaveLength(2);
    for (const c of placeCalls) {
      expect((c.args[0] as { clientOrderId: string }).clientOrderId).toBe('intent-1');
    }
  });

  it('terminal intent status → no order placed', async () => {
    const r = rig();
    r.db.intents.set('intent-1', intentRow({ status: 'executed' }));
    await processExecutionJob(r.deps, job('intent-1'));
    expect(r.quantRig.calls.filter((c) => c.method === 'placeOrder')).toHaveLength(0);
  });

  it('halt flag set → intent cancelled with reason, no order placed', async () => {
    const r = rig();
    r.db.intents.set('intent-1', intentRow());
    r.redisRig.store.set(EXECUTION_HALT_KEY, '1');
    await processExecutionJob(r.deps, job('intent-1'));

    expect(r.db.intents.get('intent-1')?.status).toBe('cancelled');
    expect(r.db.intents.get('intent-1')?.reasonCode).toBe('halted');
    expect(r.quantRig.calls.filter((c) => c.method === 'placeOrder')).toHaveLength(0);
  });

  it('broker reject → intent rejected with reason code, operator notified, no throw', async () => {
    const r = rig({
      placeOrder: () =>
        filledOrder({ status: 'REJECTED', reasonCode: 'INSUFFICIENT_MARGIN', filledUnits: 0 }),
    });
    r.db.intents.set('intent-1', intentRow());
    await processExecutionJob(r.deps, job('intent-1')); // must not throw (no BullMQ retry storm)

    expect(r.db.intents.get('intent-1')?.status).toBe('rejected');
    expect(r.db.intents.get('intent-1')?.reasonCode).toBe('INSUFFICIENT_MARGIN');
    expect([...r.db.trades.values()]).toHaveLength(0);
    expect(r.notifications.jobs.some((j) => j.data.title === 'Order rejected')).toBe(true);
  });

  it('partial fill → remainder logged in meta, operator notified, no auto-retry', async () => {
    const r = rig({
      placeOrder: () =>
        filledOrder({ status: 'PARTIAL', filledUnits: 6_000, remainderUnits: 4_000 }),
    });
    r.db.intents.set('intent-1', intentRow());
    await processExecutionJob(r.deps, job('intent-1'));

    const trade = [...r.db.trades.values()][0];
    expect(trade?.units).toBe(6_000);
    expect((trade?.meta as { partialRemainder?: number }).partialRemainder).toBe(4_000);
    expect(r.notifications.jobs.some((j) => j.data.title === 'Partial fill')).toBe(true);
    expect(r.quantRig.calls.filter((c) => c.method === 'placeOrder')).toHaveLength(1);
  });

  it('unknown outcome (gRPC deadline) → intent stays submitted for the reconciler, audit row written', async () => {
    const r = rig({
      placeOrder: () => {
        throw Object.assign(new Error('deadline'), { code: grpc.status.DEADLINE_EXCEEDED });
      },
    });
    r.db.intents.set('intent-1', intentRow());
    await processExecutionJob(r.deps, job('intent-1')); // must not throw

    expect(r.db.intents.get('intent-1')?.status).toBe('submitted');
    expect(
      r.db.audits.some(
        (a) => (a.details as { action?: string } | undefined)?.action === 'unknown_outcome',
      ),
    ).toBe(true);
  });
});
