/** BE-132 — GDPR: ZIP format integrity, export scope, erasure retention policy. */

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db.js';
import { collectExportBundle, eraseUser } from './gdpr-service.js';
import { buildZip, crc32 } from './zip.js';

// ─── zip.ts — store-only ZIP writer ──────────────────────────────────────────

describe('buildZip', () => {
  it('produces a structurally valid archive (signatures, EOCD, CRC, offsets)', () => {
    const a = Buffer.from('hello gdpr', 'utf8');
    const b = Buffer.from(JSON.stringify({ x: 1 }), 'utf8');
    const zip = buildZip([
      { name: 'a.txt', data: a },
      { name: 'dir/b.json', data: b },
    ]);

    // Local header for the first entry at offset 0.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(14)).toBe(crc32(a));
    expect(zip.readUInt32LE(18)).toBe(a.length);
    // EOCD trailer: 2 entries, central directory offset within bounds.
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    const cdOffset = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt32LE(cdOffset)).toBe(0x02014b50);
    // Second central record points back at a parseable local header.
    const firstCdLen = 46 + 'a.txt'.length;
    const secondLocal = zip.readUInt32LE(cdOffset + firstCdLen + 42);
    expect(zip.readUInt32LE(secondLocal)).toBe(0x04034b50);
    // Stored payloads are present verbatim (method 0).
    expect(zip.includes(a)).toBe(true);
    expect(zip.includes(b)).toBe(true);
  });

  it('is byte-deterministic for identical input', () => {
    const entries = [{ name: 'x.json', data: Buffer.from('{"a":1}') }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });

  it('crc32 matches the known IEEE test vector', () => {
    // Canonical vector: crc32("123456789") = 0xCBF43926.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });
});

// ─── gdpr-service.ts — fake prisma ───────────────────────────────────────────

const USER_ID = 'e5e5e5e5-5555-4e6e-8f7f-a8a8a8a8a8a8';

function fakePrisma() {
  const user: Record<string, unknown> = {
    id: USER_ID,
    email: 'ops@fx.local',
    name: 'Operator',
    image: null,
    googleId: 'g-123',
    passwordHash: 'argon2:secret-hash',
    role: 'operator',
    status: 'active',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    totpSecret: 'v1:sealed',
    twoFactorEnabledAt: new Date('2026-01-02T00:00:00Z'),
    erasedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const deletions: Record<string, number> = {};
  const deleteMany = (name: string, count: number) => async () => {
    deletions[name] = count;
    return { count };
  };
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === USER_ID ? user : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(user, data);
        return user;
      },
    },
    trade: {
      findMany: async () => [
        { id: 't-1', instrument: 'EUR_USD', realizedPnl: '12.5', units: 1000n },
      ],
      count: async () => 7,
    },
    brokerCredential: {
      findMany: async () => [
        { id: 'bc-1', broker: 'oanda', environment: 'practice', label: 'default' },
      ],
      deleteMany: deleteMany('brokerCredential', 1),
    },
    recoveryCode: {
      findMany: async () => [{ id: 'rc-1', createdAt: new Date(), usedAt: null }],
      deleteMany: deleteMany('recoveryCode', 10),
    },
    emailVerificationToken: {
      findMany: async () => [],
      deleteMany: deleteMany('emailVerificationToken', 2),
    },
    inviteCode: { findMany: async () => [] },
    inviteRedemption: { findMany: async () => [{ id: 'ir-1', redeemedAt: new Date() }] },
    auditLog: {
      findMany: async () => [
        { at: new Date(), requestId: 'r1', method: 'POST', url: '/x', statusCode: 200 },
      ],
    },
    gdprExport: { deleteMany: deleteMany('gdprExport', 1) },
  } as unknown as PrismaClient;
  return { prisma, user, deletions };
}

describe('collectExportBundle', () => {
  it('bundles every category with secrets excluded', async () => {
    const { prisma } = fakePrisma();
    const bundle = await collectExportBundle(prisma, USER_ID, new Date('2026-07-14T00:00:00Z'));
    expect(bundle).not.toBeNull();
    expect(bundle?.files).toEqual([
      'README.txt',
      'user.json',
      'trades.json',
      'security_metadata.json',
      'invites.json',
      'audit_log.json',
    ]);
    const text = bundle?.zip.toString('utf8') ?? '';
    // Personal data is in; the audit rows and trades are in.
    expect(text).toContain('ops@fx.local');
    expect(text).toContain('EUR_USD');
    expect(text).toContain('Art.\n17(3)(b)'); // retention policy stated in README
    // Security material NEVER leaves: hashes, sealed secrets, ciphertexts.
    // (The quoted-key form — the README legitimately MENTIONS "ciphertexts"
    // when explaining that they are excluded.)
    expect(text).not.toContain('argon2:secret-hash');
    expect(text).not.toContain('v1:sealed');
    expect(text).not.toContain('"ciphertext"');
  });

  it('null for an unknown user (route maps it to 401, never an empty archive)', async () => {
    const { prisma } = fakePrisma();
    expect(await collectExportBundle(prisma, 'not-a-user')).toBeNull();
  });
});

describe('eraseUser — retention policy', () => {
  it('deletes secrets/exports, anonymises the row in place, retains trades + audit', async () => {
    const { prisma, user, deletions } = fakePrisma();
    const now = new Date('2026-07-14T12:00:00Z');
    const summary = await eraseUser(prisma, USER_ID, now);

    expect(summary?.deleted).toEqual({
      recoveryCodes: 10,
      emailTokens: 2,
      brokerCredentials: 1,
      gdprExports: 1,
    });
    expect(summary?.retained.trades).toBe(7);
    expect(deletions).toMatchObject({ brokerCredential: 1, recoveryCode: 10, gdprExport: 1 });

    // Anonymised in place — personal fields cleared, spine retained.
    expect(user.email).toBe(`erased+${USER_ID}@anonymised.invalid`);
    expect(user.name).toBeNull();
    expect(user.googleId).toBeNull();
    expect(user.passwordHash).toBeNull();
    expect(user.totpSecret).toBeNull();
    expect(user.twoFactorEnabledAt).toBeNull();
    expect(user.status).toBe('suspended');
    expect(user.erasedAt).toBe(now);
    expect(user.id).toBe(USER_ID); // the FK spine survives
  });
});
