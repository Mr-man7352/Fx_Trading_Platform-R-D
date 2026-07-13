import {
  ApiErrorSchema,
  KillSwitchRequestSchema,
  type KillSwitchResponse,
  KillSwitchResponseSchema,
  type KillSwitchState,
} from '@fx/types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import {
  type CloseOutQuantClient,
  type CloseOutStatus,
  executeKillSwitchCloseOut,
  type KillSwitchRow,
  type KillSwitchStore,
} from '../execution/kill-switch.js';
import { writeWorkerAudit } from '../workers/worker-audit.js';
import { publishWsEvent } from '../workers/ws-publish.js';

/**
 * BE-072 — master kill-switch API (`/settings/kill-switch`).
 *
 * Activation sequence (§13.2, <2s target):
 *   1. Postgres state row (source of truth, ADR-012) + Redis cache +
 *      execution-halt flag — workers pause IMMEDIATELY, before any broker IO.
 *   2. Audit log entry.
 *   3. Cancel every pending TradeIntent (in-flight 'submitted' stays for the
 *      reconciler — its broker outcome is unknown).
 *   4. Market-close all open positions with retry + escalating alerts;
 *      state reports CLOSING (never flat) until broker-confirmed.
 *   5. WS + notification fan-out.
 *
 * Step-up 2FA: the request shape carries `twoFactorCode` (matches the FE-011
 * `<KillSwitchButton>` contract). As of Step 5.1 (BE-036) a supplied code is
 * verified against the acting user's TOTP / recovery codes via the wired
 * `TwoFactorVerifier`. A WRONG code blocks; NO code does not — ACTIVATION is
 * deliberately never blocked on 2FA infrastructure being down, because
 * stopping trading is the fail-safe direction.
 */

export interface TwoFactorVerifier {
  /** BE-036 — verify a TOTP or recovery code for the acting user. */
  verify(userId: string, code: string): Promise<boolean>;
}

export interface KillSwitchRouteDeps {
  store: KillSwitchStore;
  quant: CloseOutQuantClient;
  redis: Redis;
  notify(severity: 'warning' | 'critical', title: string, body: string): Promise<void>;
  /** BE-036 (Phase 5) wires the real TOTP verifier; null = record-only. */
  verifier?: TwoFactorVerifier | null;
}

function toState(row: KillSwitchRow | null): KillSwitchState {
  return {
    active: row?.active ?? false,
    reason: row?.reason ?? null,
    activatedBy: row?.activatedBy ?? null,
    activatedAt: row?.activatedAt ? row.activatedAt.toISOString() : null,
    deactivatedAt: row?.deactivatedAt ? row.deactivatedAt.toISOString() : null,
    closeOutStatus: (row?.closeOutStatus as CloseOutStatus | undefined) ?? null,
  };
}

export function registerKillSwitchRoutes(
  app: FastifyInstance,
  deps: KillSwitchRouteDeps | null,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/settings/kill-switch',
    schema: {
      tags: ['risk'],
      summary: 'Current kill-switch state (Postgres source of truth)',
      response: { 200: KillSwitchResponseSchema, 503: ApiErrorSchema },
    },
    handler: async (req, reply) => {
      if (!deps) return unavailable(reply, req.id);
      const row = await deps.store.current();
      const body: KillSwitchResponse = { state: toState(row), closeOut: null, elapsedMs: 0 };
      return body;
    },
  });

  typed.route({
    method: 'POST',
    url: '/settings/kill-switch',
    schema: {
      tags: ['risk'],
      summary: 'Activate (cancel + close-out < 2s) or deactivate the kill-switch',
      body: KillSwitchRequestSchema,
      response: {
        200: KillSwitchResponseSchema,
        400: ApiErrorSchema,
        409: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req, reply) => {
      if (!deps || !app.prisma) return unavailable(reply, req.id);
      const prisma = app.prisma;
      const started = Date.now();
      const { action, reason, twoFactorCode } = req.body;
      const actor = req.context.user?.id ?? 'unknown';

      // BE-036 — a supplied code is verified against the acting user's TOTP /
      // recovery codes. A WRONG code blocks; NO code does not (stopping trading
      // is the fail-safe direction and must never be blocked on 2FA infra).
      let twoFactorNote = 'not supplied';
      if (twoFactorCode && deps.verifier) {
        if (!(await deps.verifier.verify(actor, twoFactorCode))) {
          return reply.code(400).send({
            error: { code: 'TWO_FACTOR_INVALID', message: 'Invalid 2FA code', requestId: req.id },
          });
        }
        twoFactorNote = 'verified';
      } else if (twoFactorCode) {
        twoFactorNote = 'recorded, verifier not wired';
      }

      if (action === 'deactivate') {
        const released = await deps.store.deactivate(actor);
        if (!released) {
          return reply.code(409).send({
            error: {
              code: 'NOT_ACTIVE',
              message: 'Kill-switch is not active',
              requestId: req.id,
            },
          });
        }
        await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
          action: 'kill_switch_deactivated',
          entityType: 'kill_switch',
          entityId: released.id,
          actor,
          twoFactor: twoFactorNote,
        });
        await publishWsEvent(deps.redis, 'risk.resume', { source: 'kill-switch', actor });
        await deps.notify('warning', 'Kill-switch DEACTIVATED', `Released by ${actor}.`);
        const body: KillSwitchResponse = {
          state: toState(await deps.store.current()),
          closeOut: null,
          elapsedMs: Date.now() - started,
        };
        return body;
      }

      // ── activate ──
      if (!reason) {
        return reply.code(400).send({
          error: {
            code: 'REASON_REQUIRED',
            message: 'A reason is required to activate the kill-switch',
            requestId: req.id,
          },
        });
      }
      const existing = await deps.store.current();
      if (existing?.active) {
        return reply.code(409).send({
          error: {
            code: 'ALREADY_ACTIVE',
            message: 'Kill-switch is already active',
            requestId: req.id,
          },
        });
      }

      // 1 — state first (Postgres → Redis → halt flag): workers stop NOW.
      const row = await deps.store.activate(actor, reason);
      // 2 — audit before broker IO: activation is never lost.
      await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
        action: 'kill_switch_activated',
        entityType: 'kill_switch',
        entityId: row.id,
        actor,
        reason,
        twoFactor: twoFactorNote,
      });
      await publishWsEvent(deps.redis, 'risk.halt', { reason, source: 'kill-switch', actor });
      await deps.notify('critical', 'KILL-SWITCH ACTIVATED', `${reason} (by ${actor})`);

      // 3+4 — cancel pending, close open, broker-confirm.
      const report = await executeKillSwitchCloseOut({
        quant: deps.quant,
        cancelPendingIntents: async () => {
          const res = await prisma.tradeIntent.updateMany({
            where: { status: { in: ['pending', 'approved'] } },
            data: { status: 'cancelled', reasonCode: 'kill_switch', decidedAt: new Date() },
          });
          return res.count;
        },
        alert: (severity, title, body) => deps.notify(severity, title, body),
      });
      await deps.store.recordCloseOut(row.id, report.status, report);
      await writeWorkerAudit(prisma, app.env.TRADING_MODE, {
        action: 'kill_switch_close_out',
        entityType: 'kill_switch',
        entityId: row.id,
        status: report.status,
        brokerConfirmedFlat: report.brokerConfirmedFlat,
        pendingIntentsCancelled: report.pendingIntentsCancelled,
        elapsedMs: report.elapsedMs,
      });

      const body: KillSwitchResponse = {
        state: toState(await deps.store.current()),
        closeOut: report,
        elapsedMs: Date.now() - started,
      };
      return body;
    },
  });
}

function unavailable(reply: FastifyReply, requestId: string) {
  return reply.code(503).send({
    error: {
      code: 'KILL_SWITCH_UNAVAILABLE',
      message: 'Kill-switch dependencies are not configured for this instance',
      requestId,
    },
  });
}
