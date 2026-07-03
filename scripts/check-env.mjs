#!/usr/bin/env node
/**
 * FE-007 — pre-dev env check: missing `.env` (or missing keys) fails fast with
 * a clear list instead of services dying mid-boot with cryptic errors.
 * Also used by CI (BE-005) with --ci to assert `.env.example` stays parseable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const examplePath = resolve(root, '.env.example');
const envPath = resolve(root, '.env');
const ci = process.argv.includes('--ci');

function parseKeys(path) {
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0].trim())
      .filter(Boolean),
  );
}

if (!existsSync(examplePath)) {
  console.error('❌ .env.example is missing at the repo root.');
  process.exit(1);
}
const required = parseKeys(examplePath);

if (ci) {
  console.log(`✅ .env.example OK (${required.size} keys).`);
  process.exit(0);
}

if (!existsSync(envPath)) {
  console.error('❌ No .env file found. Create one with:\n');
  console.error('   cp .env.example .env\n');
  console.error(`Required keys: ${[...required].join(', ')}`);
  process.exit(1);
}

const present = parseKeys(envPath);
const missing = [...required].filter((k) => !present.has(k));
if (missing.length > 0) {
  console.error('❌ .env is missing required keys (see .env.example):\n');
  for (const key of missing) console.error(`   - ${key}`);
  process.exit(1);
}
console.log('✅ .env OK.');
