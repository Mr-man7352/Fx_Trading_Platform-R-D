import { ApiErrorSchema, AuditLogPageSchema, AuditLogQuerySchema } from '@fx/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * BE-130 — `GET /audit`: paginated, filterable view of the append-only
 * audit_log. Always registered (so the OpenAPI contract includes it); answers
 * 503 when built without a DB client (unit tests, OpenAPI emit).
 * Auth: internal token (Phase 1); RBAC arrives with Phase 5.
 */
export function registerAuditRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/audit',
    schema: {
      tags: ['audit'],
      summary: 'Query the append-only audit log',
      querystring: AuditLogQuerySchema,
      response: { 200: AuditLogPageSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) {
        return reply.code(503).send({
          error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId: req.id },
        });
      }
      const { page, pageSize, actorId, method, from, to } = req.query;
      const where = {
        ...(actorId ? { actorId } : {}),
        ...(method ? { method: method.toUpperCase() } : {}),
        ...(from || to
          ? {
              at: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(to) } : {}) },
            }
          : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { id: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.id.toString(),
          at: r.at.toISOString(),
          requestId: r.requestId,
          actorId: r.actorId,
          role: r.role,
          method: r.method,
          url: r.url,
          statusCode: r.statusCode,
          tradingMode: r.tradingMode,
        })),
        page,
        pageSize,
        total,
      };
    },
  });
}
