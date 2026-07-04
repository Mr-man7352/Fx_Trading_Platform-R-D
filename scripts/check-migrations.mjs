#!/usr/bin/env node
/**
 * BE-022 — destructive-migration guard (CI + pre-commit-able).
 * Scans every migration.sql under apis/node-api/prisma/migrations for statements that
 * can lose data. Any hit fails unless the migration file carries an explicit
 * acknowledgement marker line:
 *
 *   -- destructive-ok: <reason>
 *
 * This keeps "prod schema never breaks accidentally" honest: destruction is
 * possible, but only ever deliberate and reviewed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'apis/node-api/prisma/migrations');
const MARKER = /^\s*--\s*destructive-ok:\s*\S+/m;

const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /^\s*TRUNCATE\b/im, // statement-anchored: `BEFORE TRUNCATE` triggers are fine
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+(TABLE|COLUMN)\b[\s\S]*?\bTYPE\b/i, // narrowing casts can truncate
  /\bDROP\s+MATERIALIZED\s+VIEW\b/i,
];

/** Strip SQL comments so flagged keywords inside comments don't false-positive. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

let failures = 0;
let scanned = 0;

let entries = [];
try {
  entries = readdirSync(MIGRATIONS_DIR).filter((e) =>
    statSync(join(MIGRATIONS_DIR, e)).isDirectory(),
  );
} catch {
  console.log('ℹ️  No migrations directory yet — nothing to check.');
  process.exit(0);
}

for (const dir of entries) {
  const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  const body = stripComments(raw);
  const hits = DESTRUCTIVE.filter((re) => re.test(body));
  if (hits.length > 0 && !MARKER.test(raw)) {
    failures++;
    console.error(`❌ ${dir}/migration.sql contains destructive SQL without a marker:`);
    for (const re of hits) console.error(`   - matches ${re}`);
    console.error('   Add "-- destructive-ok: <reason>" to the file if this is intentional.');
  }
}

if (failures > 0) process.exit(1);
console.log(`✅ ${scanned} migration(s) checked — no unacknowledged destructive statements.`);
