import { AUTH_ERROR, type UserRole } from '@fx/types';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Env } from '../env.js';

/**
 * BE-036/037 — reusable auth guards. `requireStepUp` enforces a fresh TOTP
 * step-up (15-min window) on sensitive operations; `requireRole` gates admin
 * surfaces (invite CRUD). Kill-switch does NOT use `requireStepUp` — stopping
 * trading is the fail-safe direction and must never be blocked (see BE-072).
 */

export function isStepUpFresh(
  stepUp2FAAt: string | null,
  ttlMs: number,
  now: Date = new Date(),
): boolean {
  if (!stepUp2FAAt) return false;
  const at = new Date(stepUp2FAAt).getTime();
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= ttlMs;
}

function deny(
  reply: FastifyReply,
  req: FastifyRequest,
  code: string,
  message: string,
  status: number,
) {
  return reply.code(status).send({ error: { code, message, requestId: req.id } });
}

/** 403 STEP_UP_2FA_REQUIRED when the caller's last 2FA is stale/absent. */
export function requireStepUp(env: Env): preHandlerHookHandler {
  return async (req, reply) => {
    if (req.context.role === 'internal') return; // server-to-server bypass
    if (!isStepUpFresh(req.context.stepUp2FAAt, env.STEP_UP_2FA_TTL_MS)) {
      return deny(
        reply,
        req,
        AUTH_ERROR.STEP_UP_2FA_REQUIRED,
        'Step-up 2FA required for this action',
        403,
      );
    }
  };
}

/** 403 when the caller's role is not in the allow-list (internal always passes). */
export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (req.context.role === 'internal') return;
    if (!roles.includes(req.context.role as UserRole)) {
      return deny(reply, req, 'FORBIDDEN', 'Insufficient role', 403);
    }
  };
}
