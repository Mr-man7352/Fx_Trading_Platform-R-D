/** BE-053 — watchdog config (own .env on off-host deployment).
 *
 * Hand-rolled parsing, deliberately no zod: this process must stay
 * dependency-free so the isolated off-host build (Dockerfile copies only this
 * directory) can never break on a hoisted monorepo dependency.
 */

export interface WatchdogEnv {
  PLATFORM_HEARTBEAT_URL: string;
  WATCHDOG_OANDA_TOKEN: string;
  OANDA_ACCOUNT_ID: string;
  OANDA_ENVIRONMENT: 'practice' | 'live';
  WATCHDOG_POLL_INTERVAL_MS: number;
  WATCHDOG_TIMEOUT_MISSES: number;
  WATCHDOG_HEALTH_PORT: number;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  TWILIO_TO_NUMBER?: string;
}

function required(env: NodeJS.ProcessEnv, key: string, errors: string[]): string {
  const v = env[key]?.trim();
  if (!v) errors.push(`${key} is required`);
  return v ?? '';
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v || undefined;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  errors: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${key} must be a positive integer (got "${raw}")`);
    return fallback;
  }
  return n;
}

export function parseWatchdogEnv(env: NodeJS.ProcessEnv): WatchdogEnv {
  const errors: string[] = [];

  const heartbeatUrl = required(env, 'PLATFORM_HEARTBEAT_URL', errors);
  if (heartbeatUrl) {
    try {
      new URL(heartbeatUrl);
    } catch {
      errors.push(`PLATFORM_HEARTBEAT_URL must be a valid URL (got "${heartbeatUrl}")`);
    }
  }

  const environment = env.OANDA_ENVIRONMENT?.trim() || 'practice';
  if (environment !== 'practice' && environment !== 'live') {
    errors.push(`OANDA_ENVIRONMENT must be "practice" or "live" (got "${environment}")`);
  }

  const parsed: WatchdogEnv = {
    PLATFORM_HEARTBEAT_URL: heartbeatUrl,
    WATCHDOG_OANDA_TOKEN: required(env, 'WATCHDOG_OANDA_TOKEN', errors),
    OANDA_ACCOUNT_ID: required(env, 'OANDA_ACCOUNT_ID', errors),
    OANDA_ENVIRONMENT: environment === 'live' ? 'live' : 'practice',
    WATCHDOG_POLL_INTERVAL_MS: positiveInt(env, 'WATCHDOG_POLL_INTERVAL_MS', 60_000, errors),
    WATCHDOG_TIMEOUT_MISSES: positiveInt(env, 'WATCHDOG_TIMEOUT_MISSES', 3, errors),
    WATCHDOG_HEALTH_PORT: positiveInt(env, 'WATCHDOG_HEALTH_PORT', 4100, errors),
    TELEGRAM_BOT_TOKEN: optional(env, 'TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: optional(env, 'TELEGRAM_CHAT_ID'),
    TWILIO_ACCOUNT_SID: optional(env, 'TWILIO_ACCOUNT_SID'),
    TWILIO_AUTH_TOKEN: optional(env, 'TWILIO_AUTH_TOKEN'),
    TWILIO_FROM_NUMBER: optional(env, 'TWILIO_FROM_NUMBER'),
    TWILIO_TO_NUMBER: optional(env, 'TWILIO_TO_NUMBER'),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid watchdog env:\n  - ${errors.join('\n  - ')}`);
  }
  return parsed;
}

export function loadWatchdogEnv(): WatchdogEnv {
  try {
    return parseWatchdogEnv(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export function oandaRestHost(env: WatchdogEnv): string {
  return env.OANDA_ENVIRONMENT === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}
