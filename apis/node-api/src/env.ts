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
   * BE-013 — internal service token. From Phase 5 this authenticates
   * server-to-server callers only (workers, dead-man's switch) via the
   * `x-internal-token` header — user requests use NextAuth JWTs (BE-030).
   */
  INTERNAL_API_TOKEN: z.string().min(16, 'Use at least 16 characters'),
  /**
   * BE-030 — HS256 secret shared with the dashboard's NextAuth config; the API
   * verifies session JWTs with it (`jose`). Same value on both sides or every
   * request 401s. Generate with `openssl rand -base64 32`.
   */
  NEXTAUTH_SECRET: z.string().min(16, 'Use at least 16 characters'),
  /**
   * BE-031 — server-to-server token gating `POST /auth/sign-in-sync` (the
   * dashboard's NextAuth Google callback calls it before a user JWT exists).
   */
  INTERNAL_SYNC_TOKEN: z.string().min(16, 'Use at least 16 characters'),
  /** BE-034 — origin used to build verification/reset links in emails. */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** BE-034 — Resend API key; unset ⇒ emails are logged, not sent (mock-first). */
  RESEND_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** BE-034 — transactional From address. */
  EMAIL_FROM: z.string().default('FX Platform <onboarding@fx.local>'),
  /** BE-034 — verify/reset token lifetime (minutes). */
  AUTH_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(60),
  /** BE-033 — failed-login attempts per email+IP before a 429 (5-min window). */
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** BE-036 — TOTP issuer label shown in authenticator apps. */
  TOTP_ISSUER: z.string().default('FX Platform'),
  /** BE-036 — step-up freshness window (ms); mirrors STEP_UP_MAX_AGE_MS (15 min). */
  STEP_UP_2FA_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
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
   * BE-140 — OTLP/HTTP collector endpoint (Tempo). Optional: unset ⇒ tracing
   * fully disabled (src/otel.ts no-ops and BullMQ telemetry is not attached).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (v) => (v === '' ? undefined : v), // compose passes "" when unset
    z.string().url().optional(),
  ),
  /**
   * BE-131 — base64 of exactly 32 random bytes; seals broker credentials
   * (AES-256-GCM). Generate with `openssl rand -base64 32`. Rotation bumps
   * `broker_credentials.key_version`.
   */
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'Expected base64 of exactly 32 bytes'),
  /** BE-050 — quant gRPC address for ExecutionService (QN-030 bridge). */
  QUANT_GRPC_URL: z.string().default('localhost:50051'),
  QUANT_GRPC_WRITE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  QUANT_GRPC_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** BE-068 — RunPipeline stage budget (§2.2: 30s H1); timeout ⇒ HOLD. */
  QUANT_GRPC_PIPELINE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * BE-060 — LLM provider keys, all optional (mock-first, like OANDA): a
   * provider without a key is simply absent from the failover chain. The
   * agent graph (Step 3.2) refuses to boot with zero providers configured.
   */
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  OPENROUTER_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  OPENAI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  GEMINI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** BE-060 — monthly LLM budget (USD) driving the 90%/95% downgrade policy. */
  LLM_MONTHLY_COST_CAP_USD: z.coerce.number().positive().default(200),
  /** BE-062 — static debate rounds (entropy ≥ 2/3 forces 2 regardless, §9.6). */
  AGENT_DEBATE_ROUNDS: z.coerce.number().int().min(0).max(2).default(1),
  /** BE-064 — memory on/off; off = stateless quant-only ablation mode. */
  AGENT_MEMORY_ENABLED: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('true'))
    .transform((v) => v === 'true'),
  /**
   * BE-064 — embedding setup (§9.5 versioning). `fake` is deterministic and
   * keyless (dev/CI); switch to `openai` before paper evidence runs. The
   * model is pinned per memory row and retrieval filters on it — changing
   * provider/model requires an explicit re-embed migration, never mixing.
   */
  EMBEDDING_PROVIDER: z.enum(['openai', 'fake']).default('fake'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** ADR-008 — P(profitable) threshold (risk gate + QUANT_DEFAULT tiebreaker). */
  RISK_PROBABILITY_THRESHOLD: z.coerce.number().gt(0).lt(1).default(0.6),
  /** BE-070/071 — risk-gate rule limits (defaults = system design §10). */
  RISK_MAX_CONCURRENT_TRADES: z.coerce.number().int().positive().default(5),
  RISK_MAX_PER_CLUSTER: z.coerce.number().int().positive().default(2),
  /** Comma-separated instruments exempt from the cluster cap (audited override). */
  RISK_CLUSTER_EXEMPTIONS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  RISK_DAILY_DD_HALT_PCT: z.coerce.number().gt(0).lt(1).default(0.05),
  RISK_WEEKLY_DD_HALT_PCT: z.coerce.number().gt(0).lt(1).default(0.1),
  RISK_INSTRUMENT_DAILY_LOSS_PCT: z.coerce.number().gt(0).lt(1).default(0.02),
  RISK_MIN_RR: z.coerce.number().positive().default(1.8),
  RISK_WEEKEND_FLATTEN_ENABLED: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('false'))
    .transform((v) => v === 'true'),
  RISK_ROLLOVER_AUTOFLATTEN_XAU: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['true', 'false']).default('false'))
    .transform((v) => v === 'true'),
  /** BE-066 — paper-mode equity baseline until broker account sync exists. */
  ACCOUNT_BASELINE_EQUITY: z.coerce.number().positive().default(10_000),
  /** BE-066 — max concurrent LangGraph runs (§9.6 cap: 3). */
  SIGNALS_GRAPH_CONCURRENCY: z.coerce.number().int().positive().default(3),
  /** BE-066 — §2.2 budgets (H1); E2E measured from semaphore acquisition. */
  SIGNALS_GRAPH_BUDGET_MS: z.coerce.number().int().positive().default(120_000),
  SIGNALS_E2E_BUDGET_MS: z.coerce.number().int().positive().default(180_000),
  /** BE-052 — mismatch action: halt (default) or flatten_and_halt. */
  RECONCILE_ACTION: z.enum(['halt', 'flatten_and_halt']).default('halt'),
  /** BE-051 — trade manager overrides. */
  TRADE_MANAGER_PARTIAL_TRIGGER_R: z.coerce.number().positive().default(1),
  TRADE_MANAGER_PARTIAL_FRACTION: z.coerce.number().gt(0).lte(1).default(0.5),
  TRADE_MANAGER_BREAKEVEN_BUFFER_R: z.coerce.number().nonnegative().default(0.05),
  TRADE_MANAGER_TRAIL_DISTANCE_R: z.coerce.number().positive().default(0.5),
  /** BE-050/BE-115 — optional Telegram alerts (no-op when unset). */
  TELEGRAM_BOT_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TELEGRAM_CHAT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /**
   * BE-118 — Twilio SMS escalation for CRITICAL-severity events only
   * (kill-switch, reconciliation mismatch, circuit open, dead-man, DD halt).
   * All optional — any key missing ⇒ SMS path is inert (mock-first, like
   * Telegram); a send failure is logged AND surfaced on the dashboard
   * (`notifications` WS channel — alerting-about-alerting).
   */
  TWILIO_ACCOUNT_SID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  TWILIO_FROM_NUMBER: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** BE-118 — operator phone in E.164 (e.g. +447700900000). */
  ALERT_SMS_TO: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /**
   * BE-116 — daily/weekly digest recipient. Unset ⇒ digests are logged, not
   * sent (mock-first; Resend is used when RESEND_API_KEY is also set).
   */
  DIGEST_EMAIL_TO: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /**
   * BE-110 — economic calendar vendor. `forexfactory` = the keyless free
   * weekly JSON feed; `none` preserves the Phase-3/4 behaviour (blackout rule
   * records `calendar_unavailable` and passes — fail-open, never fabricated).
   */
  CALENDAR_PROVIDER: z.enum(['forexfactory', 'none']).default('forexfactory'),
  /** BE-110 — vendor refresh cadence (market-data worker repeatable job). */
  CALENDAR_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** BE-110 — data older than this ⇒ provider reports unavailable (fail-open). */
  CALENDAR_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(48 * 3_600_000),
  /** BE-100 — worker-side cache TTL for effective settings reads. */
  SETTINGS_CACHE_TTL_MS: z.coerce.number().int().positive().default(15_000),
  /** BE-080 — supervision scan cadence (layers + gate; LLM only on material change). */
  SUPERVISION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** BE-081 — time-stop layer: max holding hours before deterministic close. */
  SUPERVISION_TIME_STOP_HOURS: z.coerce.number().positive().default(72),
  /** BE-080 — adverse excursion (in R) that always counts as material change. */
  SUPERVISION_ADVERSE_R: z.coerce.number().positive().default(0.75),
  /** BE-080 — LLM supervisor stage budget (§2.2-style; one call per material change). */
  SUPERVISION_STAGE_BUDGET_MS: z.coerce.number().int().positive().default(15_000),
  /** BE-090 — quant service REST base URL (vectorbt backtest trigger). */
  QUANT_HTTP_URL: z.string().url().default('http://localhost:5001'),
  /** BE-090 — quant backtest HTTP timeout (vectorised runs are minutes, not ms). */
  QUANT_BACKTEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** QN-052 — LLM response cache dir for reproducible agentic backtests. */
  LLM_CACHE_DIR: z.string().default('var/llm-cache'),
  /** QN-050/056 — risk fraction per simulated trade (both engines must match). */
  BACKTEST_RISK_PCT: z.coerce.number().gt(0).lt(1).default(0.01),
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
