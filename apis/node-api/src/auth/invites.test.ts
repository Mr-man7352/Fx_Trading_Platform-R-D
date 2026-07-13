import { describe, expect, it } from 'vitest';
import { checkInvite, generateInviteCode, type InviteRow, toInviteDto } from './invites.js';

const NOW = new Date('2026-07-12T00:00:00Z');

function row(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: 'i1',
    code: 'FX-ABCD-EFGH',
    invitedEmail: null,
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    createdById: null,
    ...overrides,
  };
}

describe('BE-035 invites — validity + DTO', () => {
  it('accepts a fresh code', () => {
    expect(checkInvite(row(), { now: NOW })).toEqual({ ok: true });
  });

  it('rejects missing, revoked, expired, and exhausted codes', () => {
    expect(checkInvite(null, { now: NOW })).toMatchObject({ reason: 'not_found' });
    expect(checkInvite(row({ revokedAt: NOW }), { now: NOW })).toMatchObject({ reason: 'revoked' });
    expect(
      checkInvite(row({ expiresAt: new Date(NOW.getTime() - 1) }), { now: NOW }),
    ).toMatchObject({ reason: 'expired' });
    expect(checkInvite(row({ maxUses: 2, usedCount: 2 }), { now: NOW })).toMatchObject({
      reason: 'exhausted',
    });
  });

  it('enforces an email-bound invite', () => {
    const bound = row({ invitedEmail: 'ops@fx.local' });
    expect(checkInvite(bound, { email: 'ops@fx.local', now: NOW })).toEqual({ ok: true });
    expect(checkInvite(bound, { email: 'other@fx.local', now: NOW })).toMatchObject({
      reason: 'email_mismatch',
    });
  });

  it('generates a typable FX-XXXX-XXXX code', () => {
    expect(generateInviteCode()).toMatch(/^FX-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('derives active in the DTO', () => {
    expect(toInviteDto(row(), NOW).active).toBe(true);
    expect(toInviteDto(row({ revokedAt: NOW }), NOW).active).toBe(false);
  });
});
