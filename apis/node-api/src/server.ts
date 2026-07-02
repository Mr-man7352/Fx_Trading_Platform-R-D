/**
 * BE-001 — minimal boot target for the Node API workspace.
 * Deliberately plain `node:http`: the production-grade Fastify shell (Pino, helmet,
 * CORS, rate-limit, Zod routes, WS gateway) is Step 1.3 (BE-010…015) and replaces this file.
 */
import { createServer } from 'node:http';
import type { HealthResponse } from '@fx/types';
import { loadEnv } from './env.js';

const env = loadEnv();
const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') {
    const body: HealthResponse = {
      status: 'ok',
      commit: env.GIT_COMMIT,
      uptime: (Date.now() - startedAt) / 1000,
      tradingMode: env.TRADING_MODE,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
});

server.listen(env.API_PORT, () => {
  console.log(
    `@fx/node-api listening on :${env.API_PORT} (mode=${env.TRADING_MODE}, env=${env.NODE_ENV})`,
  );
});

// Graceful shutdown (full 30 s drain logic arrives with BE-010).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
