import type { TradingMode } from '@fx/types';
import type { FastifyBaseLogger } from 'fastify';

/**
 * BE-013 — audit trail for state-changing actions.
 * Phase 1 sink writes structured log lines; BE-130 (Step 1.4+) swaps in an
 * append-only `audit_log` table behind the same `AuditSink` interface.
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

/** Methods whose completion must be audited (BE-013 AC). */
export const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
