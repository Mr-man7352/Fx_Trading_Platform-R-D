/**
 * BE-010 — Fastify boot (replaces the BE-001 node:http placeholder).
 * `buildApp` holds all wiring; this file only loads env, listens, and
 * guarantees graceful shutdown within 30 s of SIGTERM/SIGINT.
 */

import { type ConnectionOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { AuthService } from './auth/service.js';
import { createPrismaClient } from './db.js';
import { loadEnv } from './env.js';
import { type KillSwitchDb, KillSwitchStore } from './execution/kill-switch.js';
import { QuantExecutionClient } from './execution/quant-client.js';
import {
  BACKTESTS_QUEUE,
  type BacktestJob,
  NOTIFICATIONS_QUEUE,
  type NotificationJob,
} from './workers/queues.js';
import { startWsBridge } from './ws-bridge.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

const env = loadEnv();
// BE-130 — real boot always uses the DB audit sink. Connection is lazy, so a
// down DB doesn't block boot; the first query surfaces the failure loudly.
const prisma = createPrismaClient(env);

// BE-072 — kill-switch dependencies: a command-mode Redis client (the WS
// bridge client below runs in subscriber mode and cannot issue commands),
// the gRPC execution client for close-out, and the notifications queue.
const cmdRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const notificationsQueue = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, {
  connection: cmdRedis as unknown as ConnectionOptions,
});
// BE-090 — backtest jobs are produced here, consumed by the backtests worker.
const backtestsQueue = new Queue<BacktestJob>(BACKTESTS_QUEUE, {
  connection: cmdRedis as unknown as ConnectionOptions,
});
// BE-036 — real step-up verifier: the kill-switch checks a supplied TOTP /
// recovery code against the acting user (consuming a recovery code on use).
// The verifier path never sends email, so a console logger for the AuthService
// email fallback is sufficient here (the route layer builds its own from app.log).
const authService = new AuthService({
  prisma,
  env,
  log: { info: (o, m) => console.log(m ?? '', o), error: (o, m) => console.error(m ?? '', o) },
});
const app = await buildApp(env, {
  prisma,
  killSwitch: {
    store: new KillSwitchStore(prisma as unknown as KillSwitchDb, cmdRedis),
    quant: new QuantExecutionClient(env),
    redis: cmdRedis,
    notify: async (severity, title, body) => {
      await notificationsQueue.add(
        'alert',
        { severity, title, body, event: 'kill_switch' },
        { removeOnComplete: 100 },
      );
    },
    verifier: {
      verify: (userId, code) => authService.verifyTwoFactor(userId, code).then((r) => r.ok),
    },
  },
  backtests: { queue: backtestsQueue },
});

const wsRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const stopWsBridge = startWsBridge(wsRedis, app.eventBus);
app.addHook('onClose', async () => {
  stopWsBridge();
  wsRedis.disconnect();
  await notificationsQueue.close();
  await backtestsQueue.close();
  cmdRedis.disconnect();
});

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
app.log.info(
  `@fx/node-api listening on :${env.API_PORT} (mode=${env.TRADING_MODE}, env=${env.NODE_ENV})`,
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown requested — draining connections');
    const killTimer = setTimeout(() => {
      app.log.fatal(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killTimer.unref();
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  });
}
