/**
 * QN-056 — CLI for the agentic backtest runner (no API round-trip).
 *
 *   TRADING_MODE=backtest pnpm --filter @fx/node-api backtest:agentic -- \
 *     --instrument EUR_USD --from 2026-01-05 --to 2026-03-27 \
 *     --mode cached-llm --memory on --threshold 0.6
 *
 * Requires: Postgres with backfilled candles, the quant service (gRPC) with a
 * promoted champion, and — for cached/live modes — either a warm LLM cache or
 * provider keys. Prints the result JSON to stdout.
 */
import { parseArgs } from 'node:util';
import { LlmClient } from '@fx/llm';
import { Redis } from 'ioredis';
import { runAgenticBacktest } from '../src/backtest/agentic-runner.js';
import { createPrismaClient } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { PrismaLedgerSink, PrismaSpendProvider } from '../src/signals/llm-ledger.js';
import { defaultAgenticDeps } from '../src/workers/backtests.js';
import { buildLlmAdapters } from '../src/workers/signals.js';

const { values } = parseArgs({
  options: {
    instrument: { type: 'string', default: 'EUR_USD' },
    timeframe: { type: 'string', default: 'H1' },
    from: { type: 'string' },
    to: { type: 'string' },
    mode: { type: 'string', default: 'quant-only' }, // quant-only|cached-llm|live-llm
    memory: { type: 'string', default: 'on' },
    threshold: { type: 'string', default: '0.6' },
    horizon: { type: 'string', default: '24' },
    rounds: { type: 'string' },
  },
});
if (!values.from || !values.to) {
  console.error(
    'usage: --from 2026-01-05 --to 2026-03-27 [--instrument EUR_USD] [--mode quant-only]',
  );
  process.exit(1);
}

const env = loadEnv();
const prisma = createPrismaClient(env);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const adapters = buildLlmAdapters(env);
const live =
  Object.keys(adapters).length > 0
    ? new LlmClient({
        adapters,
        ledger: new PrismaLedgerSink(prisma),
        spend: new PrismaSpendProvider(prisma),
        monthlyCapUsd: env.LLM_MONTHLY_COST_CAP_USD,
      })
    : null;

const config = {
  kind: 'agentic' as const,
  instrument: values.instrument as string,
  timeframe: values.timeframe as 'H1',
  from: new Date(`${values.from}T00:00:00Z`).toISOString(),
  to: new Date(`${values.to}T23:59:59Z`).toISOString(),
  mode: values.mode as 'quant-only' | 'cached-llm' | 'live-llm',
  memoryEnabled: values.memory !== 'off',
  probabilityThreshold: Number(values.threshold),
  riskPct: env.BACKTEST_RISK_PCT,
  initialEquity: 10_000,
  runValidation: true,
  runAblations: false,
};

const deps = defaultAgenticDeps({ prisma, redis, env }, config, live);
try {
  const result = await runAgenticBacktest(deps, {
    instrument: config.instrument,
    timeframe: config.timeframe,
    from: new Date(config.from),
    to: new Date(config.to),
    mode: config.mode,
    memoryEnabled: config.memoryEnabled,
    probabilityThreshold: config.probabilityThreshold,
    riskPct: config.riskPct,
    initialEquity: config.initialEquity,
    horizonBars: Number(values.horizon),
    debateRounds: values.rounds === undefined ? undefined : (Number(values.rounds) as 0 | 1 | 2),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  redis.disconnect();
  await prisma.$disconnect();
}
