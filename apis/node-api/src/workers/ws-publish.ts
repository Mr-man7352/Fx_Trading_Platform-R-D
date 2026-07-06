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
