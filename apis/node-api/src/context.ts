import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUDITED_METHODS } from './audit.js';
import type { Env } from './env.js';

/**
 * BE-013 — typed request context on every handler.
 * Phase 1 authenticates with an internal service token (`x-internal-token`);
 * NextAuth JWT middleware (BE-030, Phase 5) replaces the check transparently
 * behind this same `RequestContext` shape.
 */
export interface RequestContext {
  user: { id: string; email: string } | null;
  role: 'internal' | 'anonymous';
  stepUp2FAAt: string | null;
  requestId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
  interface FastifyContextConfig {
    /** Route opts out of auth (healthz, docs, ws — ws self-authenticates). */
    public?: boolean;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Header (or WS query param) token check shared by HTTP auth and the WS gateway. */
export function isInternalTokenValid(env: Env, presented: unknown): boolean {
  return typeof presented === 'string' && safeEqual(presented, env.INTERNAL_API_TOKEN);
}

export function registerContext(app: FastifyInstance, env: Env): void {
  app.decorateRequest('context');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const authenticated = isInternalTokenValid(env, req.headers['x-internal-token']);

    req.context = {
      user: authenticated ? { id: 'internal', email: 'internal@system' } : null,
      role: authenticated ? 'internal' : 'anonymous',
      stepUp2FAAt: null,
      requestId: req.id,
    };

    const isPublic =
      req.routeOptions?.config?.public === true ||
      // Swagger UI (BE-015) registers its own routes; only mounted in non-prod.
      (env.NODE_ENV !== 'production' && req.url.startsWith('/docs'));

    if (!isPublic && !authenticated) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token', requestId: req.id },
      });
    }
  });

  // BE-013 — audit every completed state-changing action.
  app.addHook('onResponse', async (req, reply) => {
    if (!AUDITED_METHODS.has(req.method)) return;
    await app.auditSink.append({
      at: new Date().toISOString(),
      requestId: req.id,
      actorId: req.context?.user?.id ?? null,
      role: req.context?.role ?? 'anonymous',
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      tradingMode: env.TRADING_MODE,
    });
  });
}
