import { timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@fx/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUDITED_METHODS } from './audit.js';
import { verifyAccessToken } from './auth/jwt.js';
import type { Env } from './env.js';

/**
 * BE-013/BE-030 — typed request context on every handler.
 *
 * Two authentication paths, one shape:
 *   - `x-internal-token` — server-to-server callers (workers, dead-man's
 *     switch) → role `internal`. Kept from Phase 1; no longer a user stand-in.
 *   - `Authorization: Bearer <jwt>` — user requests. The HS256 token is minted
 *     by the dashboard's NextAuth config (signed with `NEXTAUTH_SECRET`) and
 *     verified here (BE-030). Claims populate `user`, `role`, `stepUp2FAAt`.
 *
 * Downstream handlers written in Phases 1–4 read `req.context` unchanged.
 */
export type ContextRole = 'internal' | 'anonymous' | UserRole;

export interface RequestContext {
  user: { id: string; email: string } | null;
  role: ContextRole;
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

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function isPublicRoute(env: Env, req: FastifyRequest): boolean {
  return (
    req.routeOptions?.config?.public === true ||
    // Swagger UI (BE-015) registers its own routes; only mounted in non-prod.
    (env.NODE_ENV !== 'production' && req.url.startsWith('/docs'))
  );
}

export function registerContext(app: FastifyInstance, env: Env): void {
  app.decorateRequest('context');
  const key = new TextEncoder().encode(env.NEXTAUTH_SECRET);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const isPublic = isPublicRoute(env, req);

    // Anonymous baseline; upgraded below on a valid credential.
    req.context = { user: null, role: 'anonymous', stepUp2FAAt: null, requestId: req.id };

    // 1 — server-to-server internal token wins (workers never carry a JWT).
    if (isInternalTokenValid(env, req.headers['x-internal-token'])) {
      req.context = {
        user: { id: 'internal', email: 'internal@system' },
        role: 'internal',
        stepUp2FAAt: null,
        requestId: req.id,
      };
      return;
    }

    // 2 — user JWT (BE-030).
    const token = bearer(req);
    if (token) {
      const result = await verifyAccessToken(token, key);
      if (!result.ok) {
        // A bad token on a public route just stays anonymous; elsewhere it's 401.
        if (isPublic) return;
        return reply.code(401).send({
          error: {
            code: 'INVALID_TOKEN',
            message: result.reason === 'expired' ? 'Token expired' : 'Invalid token',
            requestId: req.id,
          },
        });
      }

      const { claims } = result;
      // Suspended users are blocked even with a valid token (BE-030 AC).
      if (app.prisma) {
        const row = await app.prisma.user.findUnique({
          where: { id: claims.sub },
          select: { status: true },
        });
        if (row?.status === 'suspended') {
          return reply.code(403).send({
            error: { code: 'SUSPENDED', message: 'Account suspended', requestId: req.id },
          });
        }
      }

      req.context = {
        user: { id: claims.sub, email: claims.email },
        role: claims.role,
        stepUp2FAAt: claims.stepUp2FAAt,
        requestId: req.id,
      };
      return;
    }

    // 3 — no credential.
    if (!isPublic) {
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
