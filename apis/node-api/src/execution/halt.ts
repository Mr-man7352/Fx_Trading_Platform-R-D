import type { Redis } from 'ioredis';

/** BE-050/052 — sticky execution halt flag (clear manually: `redis-cli DEL execution:halt`). */
export const EXECUTION_HALT_KEY = 'execution:halt';
export const EXECUTION_HEARTBEAT_KEY = 'execution:heartbeat';

/** BE-052 — Prometheus counter backing store (read by /metrics). */
export const RECONCILE_MISMATCH_METRIC_KEY = 'metrics:fx_reconciliation_mismatches_total';

export async function incrementReconcileMismatchMetric(redis: Redis): Promise<void> {
  await redis.incr(RECONCILE_MISMATCH_METRIC_KEY);
}

export async function isExecutionHalted(redis: Redis): Promise<boolean> {
  return (await redis.get(EXECUTION_HALT_KEY)) === '1';
}

export async function setExecutionHalt(redis: Redis, reason: string): Promise<void> {
  await redis.set(EXECUTION_HALT_KEY, '1');
  await redis.set(`${EXECUTION_HALT_KEY}:reason`, reason);
}

export async function touchExecutionHeartbeat(redis: Redis): Promise<void> {
  await redis.set(EXECUTION_HEARTBEAT_KEY, Date.now().toString());
}
