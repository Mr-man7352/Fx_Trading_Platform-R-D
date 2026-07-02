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
