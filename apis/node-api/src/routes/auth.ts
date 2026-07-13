import {
  AccountResponseSchema,
  ApiErrorSchema,
  AuthOkResponseSchema,
  ChangePasswordRequestSchema,
  InviteCodeSchema,
  InviteCreateRequestSchema,
  InviteListResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  RequestPasswordResetSchema,
  ResetPasswordSchema,
  SignInSyncRequestSchema,
  SignInSyncResponseSchema,
  TwoFactorEnrollCompleteResponseSchema,
  TwoFactorEnrollStartResponseSchema,
  TwoFactorEnrollVerifyRequestSchema,
  TwoFactorStatusResponseSchema,
  TwoFactorVerifyRequestSchema,
  TwoFactorVerifyResponseSchema,
  VerifyEmailQuerySchema,
} from '@fx/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, requireStepUp } from '../auth/guards.js';
import { AuthError, AuthService } from '../auth/service.js';
import { safeEqual } from '../crypto/credentials.js';
import type { Env } from '../env.js';

const InviteRevokeParams = z.object({ id: z.uuid() });

/**
 * BE-030…037 — auth API. Public endpoints (register/login/verify/reset,
 * sign-in-sync) run before a user JWT exists and are marked `public`; the
 * global context hook (BE-030) enforces JWT auth on everything else.
 *
 * `POST /auth/sign-in-sync` is server-to-server (the dashboard's NextAuth
 * Google callback) — it carries `x-internal-sync-token`, not a user JWT.
 */

function fail(reply: FastifyReply, req: FastifyRequest, err: unknown) {
  if (err instanceof AuthError) {
    return reply.code(err.status).send({
      error: { code: err.code, message: err.message, requestId: req.id },
    });
  }
  req.log.error({ err }, 'auth handler failed');
  return reply.code(500).send({
    error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.id },
  });
}

/** BE-033 — in-memory failed-login limiter (single-node platform, §7). */
class LoginLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs = 5 * 60_000,
  ) {}
  private key(email: string, ip: string) {
    return `${email.toLowerCase()}|${ip}`;
  }
  blocked(email: string, ip: string, now = Date.now()): boolean {
    const e = this.hits.get(this.key(email, ip));
    return !!e && e.resetAt > now && e.count >= this.max;
  }
  fail(email: string, ip: string, now = Date.now()): void {
    const k = this.key(email, ip);
    const e = this.hits.get(k);
    if (!e || e.resetAt <= now) {
      this.hits.set(k, { count: 1, resetAt: now + this.windowMs });
    } else {
      e.count += 1;
    }
  }
  reset(email: string, ip: string): void {
    this.hits.delete(this.key(email, ip));
  }
}

export function registerAuthRoutes(app: FastifyInstance, env: Env): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  if (!app.prisma) return; // OpenAPI emit / unit tests without a DB skip auth routes
  const svc = new AuthService({ prisma: app.prisma, env, log: app.log });
  const loginLimiter = new LoginLimiter(env.AUTH_LOGIN_MAX_ATTEMPTS);

  // ── BE-031 — user upsert on sign-in (server-to-server) ─────────────────────
  typed.route({
    method: 'POST',
    url: '/auth/sign-in-sync',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Upsert a user on Google sign-in (internal, x-internal-sync-token)',
      security: [],
      body: SignInSyncRequestSchema,
      response: { 200: SignInSyncResponseSchema, 401: ApiErrorSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      const presented = req.headers['x-internal-sync-token'];
      if (typeof presented !== 'string' || !safeEqual(presented, env.INTERNAL_SYNC_TOKEN)) {
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Invalid sync token', requestId: req.id },
        });
      }
      try {
        return await svc.signInSync(req.body);
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-032 — registration ──────────────────────────────────────────────────
  typed.route({
    method: 'POST',
    url: '/auth/register',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Register with email/password + invite code',
      security: [],
      body: RegisterRequestSchema,
      response: {
        200: RegisterResponseSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        return await svc.register(req.body);
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-033 — credentials login (NextAuth authorize target) ─────────────────
  typed.route({
    method: 'POST',
    url: '/auth/login',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Verify email/password for the NextAuth Credentials provider',
      security: [],
      body: LoginRequestSchema,
      response: {
        200: LoginResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        429: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      const ip = req.ip;
      if (loginLimiter.blocked(req.body.email, ip)) {
        return reply.code(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts, try again later',
            requestId: req.id,
          },
        });
      }
      try {
        const result = await svc.login(req.body);
        loginLimiter.reset(req.body.email, ip);
        return result;
      } catch (err) {
        if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') {
          loginLimiter.fail(req.body.email, ip);
        }
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-034 — email verification + password reset ───────────────────────────
  typed.route({
    method: 'GET',
    url: '/auth/verify',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Confirm an email verification token',
      security: [],
      querystring: VerifyEmailQuerySchema,
      response: {
        200: AuthOkResponseSchema,
        400: ApiErrorSchema,
        410: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        await svc.verifyEmail(req.query.token);
        return { ok: true as const };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/request-password-reset',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Send a password-reset email (always 200 — no user enumeration)',
      security: [],
      body: RequestPasswordResetSchema,
      response: { 200: AuthOkResponseSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      try {
        await svc.requestPasswordReset(req.body.email);
        return { ok: true as const };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/reset-password',
    config: { public: true },
    schema: {
      tags: ['auth'],
      summary: 'Set a new password from a reset token',
      security: [],
      body: ResetPasswordSchema,
      response: {
        200: AuthOkResponseSchema,
        400: ApiErrorSchema,
        410: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        await svc.resetPassword(req.body.token, req.body.password);
        return { ok: true as const };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-035 — invite CRUD (admin) ───────────────────────────────────────────
  typed.route({
    method: 'POST',
    url: '/admin/invites',
    preHandler: requireRole('admin'),
    schema: {
      tags: ['auth'],
      summary: 'Create an invite code',
      body: InviteCreateRequestSchema,
      response: { 200: InviteCodeSchema, 403: ApiErrorSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      try {
        return await svc.createInvite(req.body, req.context.user?.id ?? null);
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'GET',
    url: '/admin/invites',
    preHandler: requireRole('admin'),
    schema: {
      tags: ['auth'],
      summary: 'List invite codes with usage stats',
      response: { 200: InviteListResponseSchema, 403: ApiErrorSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      try {
        return { invites: await svc.listInvites() };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'DELETE',
    url: '/admin/invites/:id',
    preHandler: requireRole('admin'),
    schema: {
      tags: ['auth'],
      summary: 'Revoke an invite code',
      params: InviteRevokeParams,
      response: {
        200: InviteCodeSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        return await svc.revokeInvite(req.params.id);
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-036 — TOTP 2FA ──────────────────────────────────────────────────────
  typed.route({
    method: 'POST',
    url: '/auth/2fa/enroll',
    schema: {
      tags: ['auth'],
      summary: 'Begin TOTP enrollment (returns secret + otpauth URL)',
      response: {
        200: TwoFactorEnrollStartResponseSchema,
        409: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        return await svc.enroll2faStart(mustUserId(req));
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/2fa/enroll/verify',
    schema: {
      tags: ['auth'],
      summary: 'Complete enrollment with a TOTP code; returns recovery codes once',
      body: TwoFactorEnrollVerifyRequestSchema,
      response: {
        200: TwoFactorEnrollCompleteResponseSchema,
        400: ApiErrorSchema,
        409: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        const { recoveryCodes } = await svc.enroll2faVerify(mustUserId(req), req.body.code);
        return { enabled: true as const, recoveryCodes };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/2fa/verify',
    schema: {
      tags: ['auth'],
      summary: 'Step-up verification (TOTP or recovery code) — returns stepUp2FAAt',
      body: TwoFactorVerifyRequestSchema,
      response: {
        200: TwoFactorVerifyResponseSchema,
        400: ApiErrorSchema,
        409: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        const result = await svc.verifyTwoFactor(mustUserId(req), req.body.code);
        if (!result.ok) {
          return reply.code(400).send({
            error: { code: 'TWO_FACTOR_INVALID', message: 'Invalid 2FA code', requestId: req.id },
          });
        }
        return {
          stepUp2FAAt: new Date().toISOString(),
          usedRecoveryCode: result.usedRecoveryCode,
          recoveryCodesRemaining: result.recoveryCodesRemaining,
        };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'GET',
    url: '/auth/2fa/status',
    schema: {
      tags: ['auth'],
      summary: '2FA enabled flag + remaining recovery codes',
      response: { 200: TwoFactorStatusResponseSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      try {
        return await svc.twoFactorStatus(mustUserId(req));
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  // ── BE-037 — account settings ──────────────────────────────────────────────
  typed.route({
    method: 'GET',
    url: '/auth/account',
    schema: {
      tags: ['auth'],
      summary: 'Current account profile',
      response: { 200: AccountResponseSchema, 500: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      try {
        return await svc.getAccount(mustUserId(req));
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });

  typed.route({
    method: 'POST',
    url: '/auth/account/change-password',
    preHandler: requireStepUp(env),
    schema: {
      tags: ['auth'],
      summary: 'Set or change the account password (step-up 2FA required)',
      body: ChangePasswordRequestSchema,
      response: {
        200: AuthOkResponseSchema,
        400: ApiErrorSchema,
        403: ApiErrorSchema,
        500: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      try {
        await svc.changePassword(mustUserId(req), req.body);
        return { ok: true as const };
      } catch (err) {
        return fail(reply, req, err);
      }
    },
  });
}

function mustUserId(req: FastifyRequest): string {
  const id = req.context.user?.id;
  if (!id) throw new AuthError('UNAUTHORIZED', 401, 'Authentication required');
  return id;
}
