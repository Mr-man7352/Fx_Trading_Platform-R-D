import { WsClientMessageSchema, type WsServerMessage } from '@fx/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { makeSecretKey, verifyAccessToken } from '../auth/jwt.js';
import { isInternalTokenValid } from '../context.js';
import type { Env } from '../env.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * BE-014 — WebSocket gateway at `/ws`.
 * Auth: `x-internal-token` header (server-to-server) OR a NextAuth Bearer JWT
 * passed as `?token=` (browsers cannot set WS headers). A JWT connection is
 * closed with a re-auth hint the moment its `exp` passes (BE-030), so a stale
 * session can't keep streaming.
 */
export function registerWsRoutes(app: FastifyInstance, env: Env): void {
  const jwtKey = makeSecretKey(env.NEXTAUTH_SECRET);
  app.get(
    '/ws',
    { websocket: true, config: { public: true }, schema: { hide: true } },
    async (socket: WebSocket, req: FastifyRequest) => {
      const send = (msg: WsServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };

      const { token } = req.query as { token?: string };
      const presented = req.headers['x-internal-token'] ?? token;
      let expiryTimer: NodeJS.Timeout | undefined;

      if (!isInternalTokenValid(env, presented)) {
        // Not the internal token — try a user JWT from the query param.
        const result =
          typeof token === 'string'
            ? await verifyAccessToken(token, jwtKey)
            : ({ ok: false } as const);
        if (!result.ok) {
          send({ type: 'error', code: 'UNAUTHORIZED', message: 'Missing or invalid token' });
          socket.close(1008, 'unauthorized');
          return;
        }
        // Close with a re-auth hint when the token expires mid-session.
        if (result.exp) {
          const ms = result.exp * 1000 - Date.now();
          if (ms <= 0) {
            send({
              type: 'error',
              code: 'TOKEN_EXPIRED',
              message: 'Token expired — re-authenticate',
            });
            socket.close(1008, 'token-expired');
            return;
          }
          expiryTimer = setTimeout(() => {
            send({
              type: 'error',
              code: 'TOKEN_EXPIRED',
              message: 'Token expired — re-authenticate',
            });
            socket.close(1008, 'token-expired');
          }, ms);
          expiryTimer.unref?.();
        }
      }

      const subscriptions = new Map<string, () => void>();

      // Heartbeat: terminate dead connections that miss a ping round-trip.
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);

      socket.on('message', (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          send({ type: 'error', code: 'INVALID_JSON', message: 'Messages must be JSON' });
          return;
        }
        const msg = WsClientMessageSchema.safeParse(parsed);
        if (!msg.success) {
          send({
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: msg.error.issues[0]?.message ?? 'Invalid message',
          });
          return;
        }

        switch (msg.data.type) {
          case 'ping':
            send({ type: 'pong' });
            break;
          case 'subscribe': {
            const { channel } = msg.data;
            if (!subscriptions.has(channel)) {
              const unsubscribe = app.eventBus.subscribe(channel, (payload) => {
                send({ type: 'event', channel, payload, at: new Date().toISOString() });
              });
              subscriptions.set(channel, unsubscribe);
            }
            send({ type: 'subscribed', channel });
            break;
          }
          case 'unsubscribe': {
            const { channel } = msg.data;
            subscriptions.get(channel)?.();
            subscriptions.delete(channel);
            send({ type: 'unsubscribed', channel });
            break;
          }
        }
      });

      socket.on('close', () => {
        clearInterval(heartbeat);
        if (expiryTimer) clearTimeout(expiryTimer);
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        subscriptions.clear();
      });

      req.log.info({ requestId: req.id }, 'ws connection established');
    },
  );
}
