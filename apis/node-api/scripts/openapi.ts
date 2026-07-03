/**
 * BE-012/015 — `pnpm openapi`: emit the current OpenAPI document to
 * `apis/node-api/openapi.json` for api-client codegen (FE-005).
 * Builds the app without listening; env values here are emit-only placeholders.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const env = loadEnv({
  NODE_ENV: 'test',
  TRADING_MODE: 'paper',
  INTERNAL_API_TOKEN: 'openapi-emit-placeholder-token',
});

const app = await buildApp(env);
await app.ready();

const outPath = resolve(import.meta.dirname, '../openapi.json');
writeFileSync(outPath, `${JSON.stringify(app.swagger(), null, 2)}\n`);
console.log(`✅ OpenAPI written to ${outPath}`);

await app.close();
