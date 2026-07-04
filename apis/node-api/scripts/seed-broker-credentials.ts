/**
 * BE-131 — CLI seeding of sealed OANDA credentials (the Phase-5 settings
 * write path BE-100 + step-up 2FA replaces this for end users).
 *
 *   OANDA_API_TOKEN=... OANDA_ACCOUNT_ID=... pnpm --filter @fx/node-api db:seed-creds [--env practice|live] [--user email] [--label name]
 *
 * Reads DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY from the environment
 * (repo-root .env is loaded automatically). The token is never printed —
 * output shows the redacted form only.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { parseEncryptionKey, redactToken, sealCredentials } from '../src/crypto/credentials.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apiToken = process.env.OANDA_API_TOKEN;
const accountId = process.env.OANDA_ACCOUNT_ID;
const databaseUrl = process.env.DATABASE_URL;
const keyB64 = process.env.CREDENTIALS_ENCRYPTION_KEY;
if (!apiToken || !accountId || !databaseUrl || !keyB64) {
  console.error(
    '❌ Required env: OANDA_API_TOKEN, OANDA_ACCOUNT_ID, DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY',
  );
  process.exit(1);
}

const environment = arg('--env', 'practice');
if (environment !== 'practice' && environment !== 'live') {
  console.error(`❌ --env must be practice|live (got "${environment}")`);
  process.exit(1);
}
const email = arg('--user', 'dev@fx.local');
const label = arg('--label', 'default');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`❌ No user with email ${email} — run \`pnpm seed:dev\` first or pass --user.`);
    process.exit(1);
  }
  const ciphertext = sealCredentials({ apiToken, accountId }, parseEncryptionKey(keyB64));
  const row = await prisma.brokerCredential.upsert({
    where: {
      userId_broker_environment_label: {
        userId: user.id,
        broker: 'oanda',
        environment,
        label,
      },
    },
    update: { ciphertext, keyVersion: 1 },
    create: { userId: user.id, broker: 'oanda', environment, label, ciphertext },
  });
  console.log(
    `✅ Sealed OANDA ${environment} credentials for ${email} (${label}): token ${redactToken(apiToken)}, account ${accountId}, row ${row.id}.`,
  );
} finally {
  await prisma.$disconnect();
}
