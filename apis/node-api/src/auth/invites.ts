import { randomBytes } from 'node:crypto';
import type { InviteCode as InviteCodeDto } from '@fx/types';

/**
 * BE-035 — invite-code helpers. Codes are human-typable (`FX-XXXX-XXXX`) with
 * ~50 bits of entropy. Validity and DTO mapping are pure so they're unit-tested
 * without a DB; the atomic redeem (increment + redemption row) is a Prisma
 * transaction in the route.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

function block(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return out;
}

export function generateInviteCode(): string {
  return `FX-${block(4)}-${block(4)}`;
}

/** Shape shared by the Prisma row and the redemption check (structural). */
export interface InviteRow {
  id: string;
  code: string;
  invitedEmail: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdById: string | null;
}

export type InviteRejection = 'not_found' | 'revoked' | 'expired' | 'exhausted' | 'email_mismatch';

/** Deterministic validity check used by both registration and Google sync. */
export function checkInvite(
  row: InviteRow | null,
  opts: { email?: string; now?: Date } = {},
): { ok: true } | { ok: false; reason: InviteRejection } {
  const now = opts.now ?? new Date();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.usedCount >= row.maxUses) return { ok: false, reason: 'exhausted' };
  if (
    row.invitedEmail &&
    opts.email &&
    row.invitedEmail.toLowerCase() !== opts.email.toLowerCase()
  ) {
    return { ok: false, reason: 'email_mismatch' };
  }
  return { ok: true };
}

export function isInviteActive(row: InviteRow, now: Date = new Date()): boolean {
  return checkInvite(row, { now }).ok;
}

export function toInviteDto(row: InviteRow, now: Date = new Date()): InviteCodeDto {
  return {
    id: row.id,
    code: row.code,
    invitedEmail: row.invitedEmail,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    active: isInviteActive(row, now),
  };
}
