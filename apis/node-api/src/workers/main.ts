/**
 * BE-040 — market-data worker process entrypoint. Kept separate from the API
 * process (`server.ts`); run via `pnpm --filter @fx/node-api worker:market-data`
 * or the compose `worker` service. Graceful drain on SIGTERM/SIGINT.
 */
import { loadEnv } from '../env.js';
import { startMarketDataWorker } from './market-data.js';

const env = loadEnv();
const handle = startMarketDataWorker(env);
console.log(`@fx/node-api market-data worker up (mode=${env.TRADING_MODE})`); // pre-logger bootstrap line

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
