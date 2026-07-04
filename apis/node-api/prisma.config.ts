import { defineConfig } from 'prisma/config';

/**
 * BE-021/022 — Prisma 7 config. The CLI reads DATABASE_URL from the
 * environment; locally that means the repo-root .env (loaded below so
 * `pnpm --filter @fx/node-api db:*` works from anywhere).
 */
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
} catch {
  // No .env (CI provides real env vars) — fine.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // BE-023 — `prisma db seed` → deterministic dev fixtures.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Placeholder keeps URL-less commands (`prisma generate` in CI's checks
    // job) working; migrate/db commands against the placeholder just fail to
    // connect, which is the right error.
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/fx',
  },
});
