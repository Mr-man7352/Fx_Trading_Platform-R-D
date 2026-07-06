import type { Redis } from 'ioredis';
import type { EventBus } from './events.js';
import { WS_FANOUT_CHANNEL } from './workers/queues.js';

/** Bridge Redis WS fan-out from worker processes into the API EventBus. */
export function startWsBridge(redis: Redis, bus: EventBus): () => void {
  const sub = redis.duplicate();
  void sub.subscribe(WS_FANOUT_CHANNEL);
  sub.on('message', (_ch, raw) => {
    try {
      const msg = JSON.parse(raw) as { channel: string; payload: unknown };
      if (msg.channel) bus.publish(msg.channel, msg.payload);
    } catch {
      // ignore malformed
    }
  });
  return () => {
    void sub.unsubscribe(WS_FANOUT_CHANNEL);
    sub.disconnect();
  };
}
