import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import type { ApiError } from '@fx/types';
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { type AuditSink, DbAuditSink, LogAuditSink } from './audit.js';
import { registerContext } from './context.js';
import type { PrismaClient } from './db.js';
import type { Env } from './env.js';
import { EventBus } from './events.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerHealthRoutes } from './routes/health.js';
import { type KillSwitchRouteDeps, registerKillSwitchRoutes } from './routes/kill-switch.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerSignalsRoutes } from './routes/signals.js';
import { registerWsRoutes } from './routes/ws.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    eventBus: EventBus;
    auditSink: AuditSink;
    prisma: PrismaClient | null;
  }
}

export interface BuildAppOptions {
  /**
   * BE-130 — when a Prisma client is provided (server.ts always does), audits
   * go to the append-only `audit_log` table and `GET /audit` is mounted.
   * Without one (unit tests, OpenAPI emit) the Step-1.3 LogAuditSink is used.
   */
  prisma?: PrismaClient | null;
  /**
   * BE-072 — kill-switch dependencies (Redis, gRPC execution client,
   * notifications). server.ts always provides them; without them the
   * `/settings/kill-switch` routes answer 503 (unit tests, OpenAPI emit).
   */
  killSwitch?: KillSwitchRouteDeps | null;
}

/**
 * BE-010…015 — production Fastify shell (replaces the BE-001 node:http boot).
 * Factory (no listen) so tests use `app.inject()` and the OpenAPI emit script
 * can build without binding a port.
 */
export async function buildApp(env: Env, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    // BE-010 — JSON Pino logs; request completion logged in onResponse below
    // so every line carries requestId/method/url/statusCode/responseTime/userId.
    logger: { level: env.LOG_LEVEL },
    disableRequestLogging: true,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  // BE-012 — Zod schemas drive validation and serialization (matches @fx/types).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const prisma = opts.prisma ?? null;
  app.decorate('env', env);
  app.decorate('eventBus', new EventBus());
  app.decorate('prisma', prisma);
  // BE-130 — DB-backed append-only sink when a client is available.
  const auditSink: AuditSink = prisma
    ? new DbAuditSink(prisma, app.log)
    : new LogAuditSink(app.log);
  app.decorate('auditSink', auditSink);
  if (prisma) {
    app.addHook('onClose', async () => {
      await prisma.$disconnect();
    });
  }

  // BE-015 — OpenAPI 3.1 from route schemas; Swagger UI in non-prod only.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'FX Trading Platform API',
        description: 'Modular monolith API (Phase 1 — internal-token auth stand-in).',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          internalToken: { type: 'apiKey', in: 'header', name: 'x-internal-token' },
        },
      },
      security: [{ internalToken: [] }],
    },
    transform: jsonSchemaTransform,
  });
  if (env.NODE_ENV !== 'production') {
    await app.register(swaggerUI, { routePrefix: '/docs' });
  }

  // BE-011 — baseline security. CSP off: JSON-only API + Swagger UI inline scripts.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ALLOWED_ORIGINS });
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  await app.register(websocket);

  // BE-013 — request context + internal-token auth + audit hooks.
  registerContext(app, env);

  // BE-010 — request completion log line with the mandated fields.
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        requestId: req.id,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
        userId: req.context?.user?.id ?? null,
      },
      'request completed',
    );
  });

  // BE-011/012 — consistent ApiError shape everywhere.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const body: ApiError = {
        error: {
          code: 'VALIDATION',
          message: 'Request validation failed',
          requestId: req.id,
          details: err.validation.map((v) => ({
            path: v.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(root)',
            message: v.message ?? 'Invalid value',
          })),
        },
      };
      return reply.code(400).send(body);
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response serialization failed');
      return reply.code(500).send({
        error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.id },
      } satisfies ApiError);
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: err.message, requestId: req.id },
      } satisfies ApiError);
    }
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(statusCode).send({
        error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.id },
      } satisfies ApiError);
    }
    return reply.code(statusCode).send({
      error: { code: err.code ?? 'BAD_REQUEST', message: err.message, requestId: req.id },
    } satisfies ApiError);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Not found', requestId: req.id },
    } satisfies ApiError);
  });

  registerHealthRoutes(app, env);
  registerMetricsRoutes(app); // BE-141 — Prometheus scrape target
  registerWsRoutes(app, env);
  registerAuditRoutes(app); // BE-130 — GET /audit (503 without a DB client)
  registerMarketRoutes(app); // BE-042/BE-045 — /market/{instruments,candles,news}
  registerSignalsRoutes(app); // BE-067 — GET /signals (agent-cycle summaries)
  registerKillSwitchRoutes(app, opts.killSwitch ?? null); // BE-072/073 — /settings/kill-switch

  return app;
}
