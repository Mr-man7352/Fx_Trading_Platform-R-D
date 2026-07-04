import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from './env.js';
import { PrismaClient } from './generated/prisma/client.js';

export type { PrismaClient };

/**
 * BE-021 — Prisma 7 client over the `pg` driver adapter. Connections are
 * lazy: nothing dials the DB until the first query, so `buildApp` stays
 * testable without a database (tests inject no client at all).
 */
export function createPrismaClient(env: Env): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}
