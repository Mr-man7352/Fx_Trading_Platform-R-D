/**
 * BE-066 — signals worker process entrypoint. Run via
 * `pnpm --filter @fx/node-api worker:signals` or the compose service.
 * Graceful drain on SIGTERM/SIGINT (in-flight graph runs complete).
 */
import { loadEnv } from '../env.js';
import { startSignalsWorker } from './signals.js';

const env = loadEnv();
const handle = startSignalsWorker(env);
console.log(`@fx/node-api signals worker up (mode=${env.TRADING_MODE})`); // pre-logger bootstrap line

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
