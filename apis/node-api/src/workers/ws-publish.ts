import type { Redis } from 'ioredis';
import { WS_FANOUT_CHANNEL } from './queues.js';

/** Fan-out WS events from worker processes → API EventBus via Redis. */
export async function publishWsEvent(
  redis: Redis,
  channel: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(
    WS_FANOUT_CHANNEL,
    JSON.stringify({ channel, payload, at: new Date().toISOString() }),
  );
}

/**
 * BE-117 — the generalized `emit(userId, event, payload)` helper (AC shape).
 *
 * Channel conventions (single-operator today, per-user ready):
 *   - user-scoped:  `user:{userId}:events`  — frame payload `{ event, payload }`
 *   - broadcast:    the event name IS the channel (e.g. `signals`,
 *     `trade.fill`, `risk.halt`, `backtests`, `notifications`, `settings`) —
 *     what every existing publisher and the FE-120 subscriber already use.
 *
 * Both go through the same Redis fan-out (`ws:fanout`) → API ws-bridge →
 * EventBus → `/ws` gateway, so p95 delivery is bounded by one Redis pub/sub
 * hop + one in-process emit (≪ 500 ms AC).
 */
export interface WsEmitter {
  /** Emit to one user's channel (`user:{id}:events`). */
  emit(userId: string, event: string, payload: unknown): Promise<void>;
  /** Broadcast on an event-named channel (all connected dashboards). */
  broadcast(event: string, payload: unknown): Promise<void>;
}

export function createWsEmitter(redis: Redis): WsEmitter {
  return {
    async emit(userId: string, event: string, payload: unknown): Promise<void> {
      await publishWsEvent(redis, `user:${userId}:events`, { event, payload });
    },
    async broadcast(event: string, payload: unknown): Promise<void> {
      await publishWsEvent(redis, event, payload);
    },
  };
}
