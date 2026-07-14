import { randomBytes } from 'node:crypto';
import { ApiErrorSchema } from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createEmailSender, type EmailSender } from '../auth/email.js';
import { requireStepUp } from '../auth/guards.js';
import { collectExportBundle, eraseUser } from '../gdpr/gdpr-service.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';

/**
 * BE-132 — GDPR endpoints (complete before ANY invited user).
 *
 *   POST /gdpr/export           (auth) build the ZIP, store it behind a
 *                               random capability token, email the 7-day
 *                               download link (mock-first Resend seam —
 *                               without an API key the link is logged AND
 *                               returned in the response body).
 *   GET  /gdpr/exports/:token   (public capability URL) stream the ZIP;
 *                               410 Gone + row delete after expiry.
 *   POST /gdpr/erasure          (auth + STEP-UP 2FA) anonymise per the
 *                               retention policy. The body must repeat the
 *                               account email verbatim as confirmation —
 *                               erasure is irreversible.
 *
 * Retention policy lives in gdpr-service.ts (trades + audit_log retained
 * under Art. 17(3)(b); everything else deleted or anonymised in place).
 */

export interface GdprRouteDeps {
  /** Test seam; defaults to the env-driven Resend/log sender. */
  email?: EmailSender;
}

const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // story AC: 7-day link

export function registerGdprRoutes(app: FastifyInstance, deps: GdprRouteDeps = {}): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const email =
    deps.email ??
    createEmailSender(
      {
        resendApiKey: app.env.RESEND_API_KEY,
        from: app.env.EMAIL_FROM,
        appBaseUrl: app.env.APP_BASE_URL,
      },
      app.log,
    );

  typed.route({
    method: 'POST',
    url: '/gdpr/export',
    schema: {
      tags: ['gdpr'],
      summary: 'BE-132 — export my data (ZIP, emailed 7-day link)',
      response: {
        200: z.object({
          exportId: z.uuid(),
          files: z.array(z.string()),
          expiresAt: z.iso.datetime(),
          /** Returned so the mock-first email path is still usable. */
          downloadPath: z.string(),
        }),
        401: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) return dbUnavailable(reply, req.id);
      const user = req.context.user;
      if (!user || req.context.role === 'internal' || req.context.role === 'anonymous') {
        return reply.code(401).send({
          error: { code: 'AUTH_REQUIRED', message: 'sign in to export your data', requestId: req.id },
        });
      }

      const bundle = await collectExportBundle(prisma, user.id);
      if (!bundle) {
        return reply.code(401).send({
          error: { code: 'AUTH_REQUIRED', message: 'unknown user', requestId: req.id },
        });
      }
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
      const row = await prisma.gdprExport.create({
        // Prisma 7 `Bytes` = Uint8Array<ArrayBuffer>; copy out of the Buffer
        // (whose backing store is typed ArrayBufferLike) to satisfy it.
        data: { userId: user.id, token, zip: new Uint8Array(bundle.zip), expiresAt },
        select: { id: true },
      });
      const downloadPath = `/gdpr/exports/${token}`;
      await email.send({
        to: user.email,
        subject: 'Your FX Platform data export',
        text:
          `Your GDPR data export is ready. Download it within 7 days ` +
          `(link expires ${expiresAt.toISOString()}):\n\n` +
          `${app.env.APP_BASE_URL.replace(/\/$/, '')}${downloadPath}\n\n` +
          `If you did not request this export, contact the operator immediately.`,
      });
      await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
        action: 'gdpr_export_created',
        entityType: 'gdpr_export',
        entityId: row.id,
        files: bundle.files,
        expiresAt: expiresAt.toISOString(),
      });
      return {
        exportId: row.id,
        files: bundle.files,
        expiresAt: expiresAt.toISOString(),
        downloadPath,
      };
    },
  });

  typed.route({
    method: 'GET',
    url: '/gdpr/exports/:token',
    // Public capability URL: the 256-bit random token IS the credential
    // (the emailed link must work without a session, like verify/reset).
    config: { public: true },
    schema: {
      tags: ['gdpr'],
      summary: 'BE-132 — download a data export (capability link, 7-day TTL)',
      params: z.object({ token: z.string().length(64) }),
      // No response schemas: the 200 is a binary ZIP stream — declaring any
      // would route it through the JSON serializer (and constrain send()).
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) return dbUnavailable(reply, req.id);
      const row = await prisma.gdprExport.findUnique({ where: { token: req.params.token } });
      if (!row) {
        return reply.code(404).send({
          error: { code: 'EXPORT_NOT_FOUND', message: 'no such export', requestId: req.id },
        });
      }
      if (row.expiresAt.getTime() < Date.now()) {
        await prisma.gdprExport.delete({ where: { id: row.id } });
        return reply.code(410).send({
          error: {
            code: 'EXPORT_EXPIRED',
            message: 'download link expired (7 days) — request a new export',
            requestId: req.id,
          },
        });
      }
      await prisma.gdprExport.update({
        where: { id: row.id },
        data: { downloadedAt: new Date() },
      });
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="fx-data-export-${row.id}.zip"`)
        .send(Buffer.from(row.zip));
    },
  });

  typed.route({
    method: 'POST',
    url: '/gdpr/erasure',
    preHandler: requireStepUp(app.env),
    schema: {
      tags: ['gdpr'],
      summary: 'BE-132 — erase my account (anonymise per retention policy)',
      body: z.object({
        /** Must repeat the account email verbatim — erasure is irreversible. */
        confirmEmail: z.string(),
      }),
      response: {
        200: z.object({
          erased: z.literal(true),
          summary: z.record(z.string(), z.unknown()),
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      const prisma = app.prisma;
      if (!prisma) return dbUnavailable(reply, req.id);
      const user = req.context.user;
      if (!user || req.context.role === 'internal' || req.context.role === 'anonymous') {
        return reply.code(401).send({
          error: { code: 'AUTH_REQUIRED', message: 'sign in to erase your data', requestId: req.id },
        });
      }
      if (req.body.confirmEmail !== user.email) {
        return reply.code(400).send({
          error: {
            code: 'CONFIRMATION_MISMATCH',
            message: 'confirmEmail must repeat your account email verbatim',
            requestId: req.id,
          },
        });
      }
      const summary = await eraseUser(prisma, user.id);
      if (!summary) {
        return reply.code(401).send({
          error: { code: 'AUTH_REQUIRED', message: 'unknown user', requestId: req.id },
        });
      }
      // Audited BEFORE the JWT dies with the anonymised email — this row is
      // the durable record that an erasure happened and what was retained.
      await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
        action: 'gdpr_erasure_completed',
        entityType: 'user',
        entityId: user.id,
        summary,
      });
      return { erased: true as const, summary: summary as unknown as Record<string, unknown> };
    },
  });
}

function dbUnavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: { code: 'DB_UNAVAILABLE', message: 'Database not configured', requestId: requestId },
  });
}
