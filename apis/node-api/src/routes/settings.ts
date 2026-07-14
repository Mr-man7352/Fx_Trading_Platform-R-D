import {
  ApiErrorSchema,
  type BrokerCredentialsWriteResponse,
  BrokerCredentialsWriteResponseSchema,
  BrokerCredentialsWriteSchema,
  LivePromotionResponseSchema,
  SettingsPatchSchema,
  SettingsResponseSchema,
} from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { isStepUpFresh, requireStepUp } from '../auth/guards.js';
import { parseEncryptionKey, redactToken, sealCredentials } from '../crypto/credentials.js';
import type { KillSwitchStore } from '../execution/kill-switch.js';
import { evaluateLivePromotion, type LivePromotionFacts } from '../settings/live-promotion.js';
import { SettingsService } from '../settings/settings-service.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';
import { publishWsEvent } from '../workers/ws-publish.js';

/**
 * BE-100/BE-101 — settings CRUD + broker-credentials write + live-promotion
 * gate. Always registered (OpenAPI contract); answers 503 without a DB client
 * (unit tests, OpenAPI emit), matching the audit/kill-switch route convention.
 *
 * - PATCH /settings — validated against @fx/types (authoritative bounds),
 *   appended as a new version; workers pick it up next cycle (BE-100 AC).
 * - PUT /settings/broker-credentials — step-up 2FA REQUIRED (BE-036);
 *   AES-256-GCM sealed (BE-131 envelope, same as the CLI seed path).
 * - GET/POST /settings/live-promotion — BE-101: POST answers 403 with the
 *   checklist of unmet conditions until everything passes (fail-safe).
 */

export interface SettingsRouteDeps {
  /** WS fan-out so open dashboards see settings changes immediately. */
  redis: Redis | null;
  /** BE-101 — kill-switch state feeds the promotion checklist. */
  killSwitch: KillSwitchStore | null;
}

function dbUnavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId },
  });
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps | null): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const env = app.env;

  typed.route({
    method: 'GET',
    url: '/settings',
    schema: {
      tags: ['settings'],
      summary: 'Effective platform settings (latest version merged over defaults)',
      response: { 200: SettingsResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const service = new SettingsService(app.prisma);
      return service.effective();
    },
  });

  typed.route({
    method: 'PATCH',
    url: '/settings',
    schema: {
      tags: ['settings'],
      summary: 'Merge a validated partial update as a new settings version',
      body: SettingsPatchSchema,
      response: { 200: SettingsResponseSchema, 400: ApiErrorSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const service = new SettingsService(app.prisma);
      const actor = req.context.user?.id ?? null;
      const result = await service.patch(req.body, actor);
      await writeWorkerAudit(app.prisma, env.TRADING_MODE, {
        action: 'settings_updated',
        entityType: 'platform_settings',
        entityId: String(result.version),
        actor: actor ?? 'internal',
        patch: req.body,
      });
      if (deps?.redis) {
        await publishWsEvent(deps.redis, 'settings', {
          event: 'settings:updated',
          version: result.version,
          updatedBy: result.updatedBy,
        });
      }
      return result;
    },
  });

  typed.route({
    method: 'PUT',
    url: '/settings/broker-credentials',
    preHandler: [requireStepUp(env)],
    schema: {
      tags: ['settings'],
      summary: 'Seal + store broker credentials (step-up 2FA required)',
      body: BrokerCredentialsWriteSchema,
      response: {
        200: BrokerCredentialsWriteResponseSchema,
        400: ApiErrorSchema,
        403: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const userId = req.context.user?.id;
      if (!userId) {
        return reply.code(400).send({
          error: {
            code: 'USER_REQUIRED',
            message: 'Broker credentials belong to a user — call with a user token',
            requestId: req.id,
          },
        });
      }
      const { broker, environment, label, apiToken, accountId } = req.body;
      const key = parseEncryptionKey(env.CREDENTIALS_ENCRYPTION_KEY);
      const ciphertext = sealCredentials({ apiToken, accountId }, key);
      const row = await app.prisma.brokerCredential.upsert({
        where: {
          userId_broker_environment_label: { userId, broker, environment, label },
        },
        create: { userId, broker, environment, label, ciphertext },
        update: { ciphertext },
      });
      await writeWorkerAudit(app.prisma, env.TRADING_MODE, {
        action: 'broker_credentials_written',
        entityType: 'broker_credential',
        entityId: row.id,
        actor: userId,
        broker,
        environment,
        label,
        tokenPreview: redactToken(apiToken), // never the token itself
      });
      const body: BrokerCredentialsWriteResponse = {
        id: row.id,
        broker,
        environment,
        label,
        tokenPreview: redactToken(apiToken),
        updatedAt: row.updatedAt.toISOString(),
      };
      return body;
    },
  });

  typed.route({
    method: 'GET',
    url: '/settings/live-promotion',
    schema: {
      tags: ['settings'],
      summary: 'Live-promotion checklist (read-only; POST to request promotion)',
      response: { 200: LivePromotionResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      return evaluateLivePromotion(await gatherFacts(app, deps, req.context.stepUp2FAAt));
    },
  });

  typed.route({
    method: 'POST',
    url: '/settings/live-promotion',
    preHandler: [requireStepUp(env)],
    schema: {
      tags: ['settings'],
      summary: 'Request live promotion — 403 with unmet checklist until all conditions pass',
      response: {
        200: LivePromotionResponseSchema,
        403: LivePromotionResponseSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      if (!app.prisma) return dbUnavailable(reply, req.id);
      const result = evaluateLivePromotion(await gatherFacts(app, deps, req.context.stepUp2FAAt));
      const actor = req.context.user?.id ?? 'internal';
      if (!result.allowed) {
        await writeWorkerAudit(app.prisma, env.TRADING_MODE, {
          action: 'live_promotion_denied',
          entityType: 'live_promotion',
          entityId: actor,
          unmet: result.checklist.filter((c) => !c.ok).map((c) => c.id),
        });
        return reply.code(403).send(result);
      }
      await writeWorkerAudit(app.prisma, env.TRADING_MODE, {
        action: 'live_promotion_approved',
        entityType: 'live_promotion',
        entityId: actor,
        checklist: result.checklist,
      });
      if (deps?.redis) {
        await publishWsEvent(deps.redis, 'settings', {
          event: 'live_promotion:approved',
          actor,
        });
      }
      return result;
    },
  });

  async function gatherFacts(
    fastify: FastifyInstance,
    routeDeps: SettingsRouteDeps | null,
    stepUp2FAAt: string | null,
  ): Promise<LivePromotionFacts> {
    const prisma = fastify.prisma;
    if (!prisma) throw new Error('gatherFacts requires a DB client');
    const [champion, latestFinished, latestPaperValidation, killSwitchActive] = await Promise.all(
      [
        prisma.modelRegistryEntry.findFirst({
          where: { role: 'champion' },
          orderBy: { promotedAt: 'desc' },
          select: { instrument: true, timeframe: true, version: true },
        }),
        prisma.backtestRun.findFirst({
          where: { status: 'finished', validationVerdict: { not: null } },
          orderBy: { finishedAt: 'desc' },
          select: { validationVerdict: true },
        }),
        // QN-060 — latest paper-validation verdict row (quant service writes it).
        prisma.paperValidationRun.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { verdict: true, createdAt: true, underpowered: true },
        }),
        routeDeps?.killSwitch ? routeDeps.killSwitch.isActive() : Promise.resolve(false),
      ],
    );
    // QN-061 — latest signed risk report (quant service writes it).
    const latestRiskReport = await prisma.riskReport.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, sha256: true },
    });
    return {
      stepUpFresh: isStepUpFresh(stepUp2FAAt, env.STEP_UP_2FA_TTL_MS),
      champion: champion
        ? {
            instrument: champion.instrument,
            timeframe: String(champion.timeframe),
            version: champion.version,
          }
        : null,
      latestValidationVerdict: latestFinished?.validationVerdict ?? null,
      paperValidation: latestPaperValidation
        ? {
            verdict: latestPaperValidation.verdict,
            at: latestPaperValidation.createdAt,
            underpowered: latestPaperValidation.underpowered,
          }
        : null,
      signedRiskReport: latestRiskReport
        ? { at: latestRiskReport.createdAt, sha256: latestRiskReport.sha256 }
        : null,
      killSwitchActive,
    };
  }
}
