import type { TradingMode } from '@fx/types';
import type { FastifyBaseLogger } from 'fastify';

/**
 * BE-013/BE-130 — audit trail for state-changing actions.
 * Phase 1 (Step 1.3) shipped `LogAuditSink`; Step 1.4 adds `DbAuditSink`
 * writing to the append-only `audit_log` table (UPDATE/DELETE/TRUNCATE are
 * blocked by a DB trigger — see the init migration). Same interface, so
 * callers never know which sink is active.
 */
export interface AuditEvent {
  at: string;
  requestId: string;
  actorId: string | null;
  role: string;
  method: string;
  url: string;
  statusCode: number;
  tradingMode: TradingMode;
}

export interface AuditSink {
  append(event: AuditEvent): void | Promise<void>;
}

export class LogAuditSink implements AuditSink {
  constructor(private readonly log: FastifyBaseLogger) {}

  append(event: AuditEvent): void {
    // One line per event, `audit: true` for easy filtering/shipping.
    this.log.info({ audit: true, ...event }, 'audit');
  }
}

/**
 * Structural slice of the generated PrismaClient — keeps this module (and its
 * unit tests) independent of `prisma generate` output.
 */
export interface AuditLogWriter {
  auditLog: {
    create(args: {
      data: {
        at: Date;
        requestId: string;
        actorId: string | null;
        role: string;
        method: string;
        url: string;
        statusCode: number;
        tradingMode: TradingMode;
      };
    }): Promise<unknown>;
  };
}

/** BE-130 — DB-backed append-only sink. */
export class DbAuditSink implements AuditSink {
  constructor(
    private readonly db: AuditLogWriter,
    private readonly log: FastifyBaseLogger,
  ) {}

  async append(event: AuditEvent): Promise<void> {
    const { at, ...rest } = event;
    try {
      await this.db.auditLog.create({ data: { at: new Date(at), ...rest } });
    } catch (err) {
      // Audit must never take the API down, but a failed append is loud:
      // error-level log carries the full event so nothing is silently lost.
      this.log.error({ err, audit: true, ...event }, 'audit append failed');
    }
  }
}

/** Methods whose completion must be audited (BE-013 AC). */
export const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
