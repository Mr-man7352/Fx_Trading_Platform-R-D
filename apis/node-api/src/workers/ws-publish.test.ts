import { describe, expect, it } from 'vitest';
import { WS_FANOUT_CHANNEL } from './queues.js';
import { createWsEmitter, publishWsEvent } from './ws-publish.js';

/** BE-117 — emit(userId, event, payload) helper + channel conventions. */

function fakeRedis() {
  const published: Array<{ channel: string; message: string }> = [];
  return {
    published,
    redis: {
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      },
    } as unknown as import('ioredis').Redis,
  };
}

describe('createWsEmitter (BE-117)', () => {
  it('emit(userId, event, payload) targets user:{id}:events with an event frame', async () => {
    const { redis, published } = fakeRedis();
    await createWsEmitter(redis).emit('user-1', 'trade.fill', { tradeId: 't1' });
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(WS_FANOUT_CHANNEL);
    const frame = JSON.parse(published[0]?.message ?? '{}');
    expect(frame.channel).toBe('user:user-1:events');
    expect(frame.payload).toEqual({ event: 'trade.fill', payload: { tradeId: 't1' } });
    expect(frame.at).toBeTypeOf('string');
  });

  it('broadcast(event, payload) uses the event name as the channel (existing convention)', async () => {
    const { redis, published } = fakeRedis();
    await createWsEmitter(redis).broadcast('risk.halt', { reason: 'dd' });
    const frame = JSON.parse(published[0]?.message ?? '{}');
    expect(frame.channel).toBe('risk.halt');
    expect(frame.payload).toEqual({ reason: 'dd' });
  });

  it('publishWsEvent (legacy shape) stays wire-compatible', async () => {
    const { redis, published } = fakeRedis();
    await publishWsEvent(redis, 'signals', { event: 'signal:hold' });
    const frame = JSON.parse(published[0]?.message ?? '{}');
    expect(frame.channel).toBe('signals');
  });
});
