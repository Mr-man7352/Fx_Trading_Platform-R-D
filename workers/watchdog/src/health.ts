import { createServer } from 'node:http';
import type { WatchdogEnv } from './env.js';

/** BE-053 — dead-man's-dead-man: external uptime check pings this. */
export function startHealthServer(env: WatchdogEnv): void {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'fx-watchdog' }));
  });
  server.listen(env.WATCHDOG_HEALTH_PORT, '0.0.0.0');
}
