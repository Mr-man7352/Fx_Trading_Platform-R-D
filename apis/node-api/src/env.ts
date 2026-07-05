import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TradingModeSchema } from '@fx/types';
import { z } from 'zod';

/**
 * BE-002 — fail-fast env validation. Boot with a missing/invalid key prints a
 * clear error list and exits; the server never starts half-configured.
 * Every key added here MUST also be added to the root `.env.example` (CI-checked, BE-005).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** BE-003 — the single mode flag: backtest | paper | live. */
  TRADING_MODE: TradingModeSchema,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GIT_COMMIT: z
    .string()
    .default('dev')
    .transform((v) => v || 'dev'),
  /**
   * BE-013 — Phase 1 auth stand-in: every non-public route requires this token
   * in the `x-internal-token` header (WS also accepts `?token=`). Replaced
   * transparently by NextAuth JWT middleware (BE-030) in Phase 5.
   */
  INTERNAL_API_TOKEN: z.string().min(16, 'Use at least 16 characters'),
  /** BE-011 — comma-separated CORS allowlist. */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** BE-011 — max requests per IP per minute. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  /** BE-021 — Postgres/TimescaleDB connection string (Prisma + pg adapter). */
  DATABASE_URL: z.string().startsWith('postgres', 'Expected a postgres:// connection string'),
  /** BE-040 — Redis connection for the BullMQ market-data + signals queues. */
  REDIS_URL: z
    .string()
    .startsWith('redis', 'Expected a redis:// connection string')
    .default('redis://localhost:6379'),
  /**
   * Step 1.6 market-data providers — all optional in mock-first mode: without
   * them the OANDA stream/backfill, Twelve Data cross-check and macro ingest
   * are inert (no-ops), but nothing fails to boot. Supply the practice-account
   * values to run against live venues.
   */
  OANDA_API_TOKEN: z.string().optional(),
  OANDA_ACCOUNT_ID: z.string().optional(),
  OANDA_ENVIRONMENT: z.enum(['practice', 'live']).default('practice'),
  TWELVE_DATA_API_KEY: z.string().optional(),
  FRED_API_KEY: z.string().optional(),
  EIA_API_KEY: z.string().optional(),
  /**
   * BE-131 — base64 of exactly 32 random bytes; seals broker credentials
   * (AES-256-GCM). Generate with `openssl rand -base64 32`. Rotation bumps
   * `broker_credentials.key_version`.
   */
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Expected base64 of exactly 32 bytes'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Load `.env` files into process.env (real environment variables win).
 * Checked locations: workspace cwd, then the repo root (when run via
 * `pnpm --filter @fx/node-api dev`, cwd is `apis/node-api`).
 */
function loadDotEnvFiles(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const path of candidates) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
    }
  }
}

export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  if (!source) {
    loadDotEnvFiles();
  }
  const result = EnvSchema.safeParse(source ?? process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    console.error('See .env.example at the repo root for required keys.');
    process.exit(1);
  }
  return result.data;
}
