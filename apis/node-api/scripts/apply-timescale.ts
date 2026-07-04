/**
 * BE-020 — applies prisma/timescale.sql (hypertables, CAGGs, compression,
 * retention) statement-by-statement OUTSIDE a transaction. Run after every
 * `prisma migrate deploy` — the file is idempotent.
 *
 *   pnpm --filter @fx/node-api db:timescale [--refresh]
 *
 * --refresh additionally materializes all candle CAGGs over their full range
 * (needed after backfills/seeds; the scheduled policies only cover the recent
 * window).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load the repo-root .env (real env vars win), same as env.ts/seed scripts.
for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

const CAGGS = ['candles_m5', 'candles_m15', 'candles_h1', 'candles_h4', 'candles_d1'];

function loadStatements(): string[] {
  const sqlPath = fileURLToPath(new URL('../prisma/timescale.sql', import.meta.url));
  const raw = readFileSync(sqlPath, 'utf8');
  // Naive-but-sufficient split: `;` at end of line terminates a statement.
  // timescale.sql bans dollar-quoted bodies for exactly this reason.
  return raw
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is not set.');
    process.exit(1);
  }
  const refresh = process.argv.includes('--refresh');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const statements = loadStatements();
    for (const [i, sql] of statements.entries()) {
      const label = sql.replace(/\s+/g, ' ').slice(0, 80);
      try {
        await client.query(sql);
        console.log(`✅ [${i + 1}/${statements.length}] ${label}`);
      } catch (err) {
        console.error(`❌ [${i + 1}/${statements.length}] ${label}`);
        throw err;
      }
    }
    if (refresh) {
      for (const cagg of CAGGS) {
        // NULL range = everything. Must run outside a transaction (it does:
        // pg.Client sends single statements without wrapping).
        await client.query(`CALL refresh_continuous_aggregate('${cagg}', NULL, NULL)`);
        console.log(`🔄 refreshed ${cagg}`);
      }
    }
    console.log('✅ TimescaleDB layer applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
