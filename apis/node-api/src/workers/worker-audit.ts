import type { TradingMode } from '@fx/types';
import type { PrismaClient } from '../db.js';

/** BE-050 — append-only audit rows from workers (not HTTP requests). */
export async function writeWorkerAudit(
  prisma: PrismaClient,
  tradingMode: TradingMode,
  details: {
    action: string;
    entityType: string;
    entityId: string;
    [key: string]: unknown;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      at: new Date(),
      requestId: `worker:${details.action}`,
      actorId: null,
      role: 'worker',
      method: 'WORKER',
      url: `/workers/${details.entityType}/${details.entityId}`,
      statusCode: 200,
      tradingMode,
      details: details as never,
    },
  });
}
