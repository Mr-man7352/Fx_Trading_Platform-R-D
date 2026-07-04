/**
 * BE-010 — Fastify boot (replaces the BE-001 node:http placeholder).
 * `buildApp` holds all wiring; this file only loads env, listens, and
 * guarantees graceful shutdown within 30 s of SIGTERM/SIGINT.
 */
import { buildApp } from './app.js';
import { createPrismaClient } from './db.js';
import { loadEnv } from './env.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

const env = loadEnv();
// BE-130 — real boot always uses the DB audit sink. Connection is lazy, so a
// down DB doesn't block boot; the first query surfaces the failure loudly.
const app = await buildApp(env, { prisma: createPrismaClient(env) });

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
