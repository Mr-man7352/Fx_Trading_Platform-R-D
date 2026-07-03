import { z } from 'zod';

/**
 * BE-014 — WebSocket gateway wire contract (`/ws`).
 * Phase 1: internal-token auth; channels are free-form strings
 * (e.g. `user:{userId}:events`, `system:events`). JWT auth + per-user
 * authorization arrive in Phase 5 (BE-030) behind the same message shapes.
 */
export const WsChannelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/, 'Channel may contain [a-zA-Z0-9:_-] only');
export type WsChannel = z.infer<typeof WsChannelSchema>;

/** Messages the client may send to the gateway. */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channel: WsChannelSchema }),
  z.object({ type: z.literal('unsubscribe'), channel: WsChannelSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

/** Messages the gateway sends to the client. */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribed'), channel: WsChannelSchema }),
  z.object({ type: z.literal('unsubscribed'), channel: WsChannelSchema }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('event'),
    channel: WsChannelSchema,
    payload: z.unknown(),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
