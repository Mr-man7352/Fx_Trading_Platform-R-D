/**
 * BE-132 — GDPR export + erasure (Art. 15 / Art. 17).
 *
 * EXPORT: every category of personal data the platform holds on the user,
 * bundled as JSON files in a store-only ZIP (zip.ts) with a README stating
 * scope and retention policy. Secrets are exported as METADATA ONLY —
 * password/recovery-code hashes, sealed TOTP secrets, and broker-credential
 * ciphertexts are security material, not portable personal data.
 *
 * ERASURE (with confirmation): anonymise-in-place per the retention policy —
 *   deleted   recovery codes, email-verification tokens, broker credentials,
 *             pending GDPR exports.
 *   cleared   email → tombstone, name/image/googleId/passwordHash/totpSecret
 *             → null, status → suspended, erasedAt set.
 *   retained  trades/intents (financial records — Art. 17(3)(b) legal
 *             obligation), invite redemptions (invite-audit spine, user link
 *             already SetNull-safe), and the append-only audit_log (BE-130's
 *             DB trigger forbids UPDATE/DELETE by design; rows reference the
 *             now-anonymised actor id only).
 */

import type { PrismaClient } from '../db.js';
import { buildZip, type ZipEntry } from './zip.js';

// ── export ───────────────────────────────────────────────────────────────────

const README = `FX Platform — GDPR data export (BE-132)

This archive contains every category of personal data the platform stores
about you, as JSON. Notes on scope:

- security_metadata.json lists your credential/2FA/recovery artifacts as
  METADATA ONLY (created/used timestamps). Hashes, sealed secrets and broker
  credential ciphertexts are security material and are not exportable.
- audit_log.json contains the append-only audit rows where you are the actor.
- trades.json contains trades attributed to your user id.

Retention on erasure: trades and audit rows are retained under GDPR Art.
17(3)(b) (legal obligation — financial record-keeping); everything else is
deleted or anonymised in place.
`;

export interface ExportBundle {
  zip: Buffer;
  /** File names included (for the audit trail / tests). */
  files: string[];
}

export async function collectExportBundle(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<ExportBundle | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const [trades, credentials, recoveryCodes, tokens, invitesCreated, invitesRedeemed, auditRows] =
    await Promise.all([
      prisma.trade.findMany({ where: { userId }, orderBy: { openedAt: 'asc' } }),
      prisma.brokerCredential.findMany({
        where: { userId },
        select: {
          id: true,
          broker: true,
          environment: true,
          label: true,
          keyVersion: true,
          createdAt: true,
          updatedAt: true,
          lastUsedAt: true,
          // ciphertext deliberately excluded — security material.
        },
      }),
      prisma.recoveryCode.findMany({
        where: { userId },
        select: { id: true, createdAt: true, usedAt: true }, // hash excluded
      }),
      prisma.emailVerificationToken.findMany({
        where: { userId },
        select: { id: true, purpose: true, createdAt: true, expiresAt: true, usedAt: true },
      }),
      prisma.inviteCode.findMany({
        where: { createdById: userId },
        select: { id: true, code: true, invitedEmail: true, createdAt: true, usedCount: true },
      }),
      prisma.inviteRedemption.findMany({
        where: { userId },
        select: { id: true, inviteCodeId: true, redeemedAt: true },
      }),
      prisma.auditLog.findMany({
        where: { actorId: userId },
        orderBy: { at: 'asc' },
        select: {
          at: true,
          requestId: true,
          method: true,
          url: true,
          statusCode: true,
          details: true,
        },
      }),
    ]);

  const json = (value: unknown) =>
    Buffer.from(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
      'utf8',
    );
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: Buffer.from(README, 'utf8') },
    {
      name: 'user.json',
      data: json({
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        googleId: user.googleId,
        role: user.role,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        twoFactorEnabledAt: user.twoFactorEnabledAt,
        createdAt: user.createdAt,
      }),
    },
    { name: 'trades.json', data: json(trades) },
    {
      name: 'security_metadata.json',
      data: json({ brokerCredentials: credentials, recoveryCodes, emailTokens: tokens }),
    },
    { name: 'invites.json', data: json({ created: invitesCreated, redeemed: invitesRedeemed }) },
    { name: 'audit_log.json', data: json(auditRows) },
  ];
  return { zip: buildZip(entries, now), files: entries.map((e) => e.name) };
}

// ── erasure ──────────────────────────────────────────────────────────────────

export interface ErasureSummary {
  userId: string;
  anonymisedEmail: string;
  deleted: {
    recoveryCodes: number;
    emailTokens: number;
    brokerCredentials: number;
    gdprExports: number;
  };
  retained: { trades: number; auditRows: 'append-only (Art. 17(3)(b))' };
}

export async function eraseUser(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<ErasureSummary | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const anonymisedEmail = `erased+${userId}@anonymised.invalid`;
  const [recoveryCodes, emailTokens, brokerCredentials, gdprExports, trades] = await Promise.all([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.brokerCredential.deleteMany({ where: { userId } }),
    prisma.gdprExport.deleteMany({ where: { userId } }),
    prisma.trade.count({ where: { userId } }),
  ]);
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: anonymisedEmail,
      name: null,
      image: null,
      googleId: null,
      passwordHash: null,
      totpSecret: null,
      twoFactorEnabledAt: null,
      status: 'suspended',
      erasedAt: now,
    },
  });
  return {
    userId,
    anonymisedEmail,
    deleted: {
      recoveryCodes: recoveryCodes.count,
      emailTokens: emailTokens.count,
      brokerCredentials: brokerCredentials.count,
      gdprExports: gdprExports.count,
    },
    retained: { trades, auditRows: 'append-only (Art. 17(3)(b))' },
  };
}
