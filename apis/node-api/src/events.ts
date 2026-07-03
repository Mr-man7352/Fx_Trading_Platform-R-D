import { EventEmitter } from 'node:events';

/**
 * BE-014 — minimal in-process pub/sub feeding the WS gateway.
 * Phase 2+ replaces the publish side with Redis-backed fan-out (BullMQ events)
 * behind this same interface; the gateway only ever sees `subscribe`.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many WS clients may subscribe to the same channel.
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, payload: unknown): void {
    this.emitter.emit(channel, payload);
  }

  /** Returns an unsubscribe function. */
  subscribe(channel: string, handler: (payload: unknown) => void): () => void {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }
}
