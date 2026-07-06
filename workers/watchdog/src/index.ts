/**
 * BE-053 — off-host dead-man's switch (ADR-013).
 * Polls platform heartbeat; on consecutive failures flattens via OANDA REST
 * using its own token — never via the platform stack. Core logic lives in
 * watchdog.ts (unit-tested); this file is only wiring.
 */
import { alertCritical } from './alert.js';
import { loadWatchdogEnv, oandaRestHost } from './env.js';
import { startHealthServer } from './health.js';
import { flattenAll } from './oanda.js';
import { classifyHeartbeat, type HeartbeatState, Watchdog } from './watchdog.js';

const env = loadWatchdogEnv();
startHealthServer(env);

async function pollHeartbeat(): Promise<HeartbeatState> {
  try {
    const res = await fetch(env.PLATFORM_HEARTBEAT_URL, { signal: AbortSignal.timeout(10_000) });
    const body = res.ok ? ((await res.json()) as { status?: string }) : null;
    return classifyHeartbeat(res.ok, body);
  } catch {
    return 'down';
  }
}

const watchdog = new Watchdog({
  pollHeartbeat,
  flatten: () => flattenAll(oandaRestHost(env), env.WATCHDOG_OANDA_TOKEN, env.OANDA_ACCOUNT_ID),
  alert: (text) => alertCritical(env, text),
  timeoutMisses: env.WATCHDOG_TIMEOUT_MISSES,
});

console.log(`fx-watchdog started → ${env.PLATFORM_HEARTBEAT_URL}`);
await watchdog.tick();
setInterval(() => void watchdog.tick(), env.WATCHDOG_POLL_INTERVAL_MS);
