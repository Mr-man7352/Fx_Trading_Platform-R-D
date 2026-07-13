import type {
  AccountResponse,
  InviteCreateRequest,
  LoginResponse,
  RegisterResponse,
  SignInSyncResponse,
  TwoFactorEnrollStartResponse,
  UserRole,
} from '@fx/types';
import { AUTH_ERROR } from '@fx/types';
import { parseEncryptionKey } from '../crypto/credentials.js';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';
import {
  createEmailSender,
  type EmailLogger,
  type EmailSender,
  passwordResetEmail,
  verificationEmail,
} from './email.js';
import { checkInvite, generateInviteCode, type InviteRow, toInviteDto } from './invites.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateRecoveryCodes, hashRecoveryCodes, verifyRecoveryCode } from './recovery-codes.js';
import { createToken, hashToken, isExpired } from './tokens.js';
import { generateTotpEnrollment, openTotpSecret, sealTotpSecret, verifyTotp } from './totp.js';

/**
 * BE-031…037 — auth service. All DB access for the auth surface lives here so
 * the route layer stays a thin, schema-validated shell. A typed error subclass
 * lets handlers map failures to the right status without leaking existence.
 */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  env: Env;
  email?: EmailSender;
  log: EmailLogger;
}

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly env: Env;
  private readonly email: EmailSender;
  private readonly credKey: Buffer;

  constructor(deps: AuthServiceDeps) {
    this.prisma = deps.prisma;
    this.env = deps.env;
    this.email =
      deps.email ??
      createEmailSender(
        {
          resendApiKey: deps.env.RESEND_API_KEY,
          from: deps.env.EMAIL_FROM,
          appBaseUrl: deps.env.APP_BASE_URL,
        },
        deps.log,
      );
    this.credKey = parseEncryptionKey(deps.env.CREDENTIALS_ENCRYPTION_KEY);
  }

  // ── BE-031 — user upsert on sign-in (server-to-server) ─────────────────────
  async signInSync(input: {
    email: string;
    googleSub?: string;
    name?: string | null;
    image?: string | null;
    inviteCode?: string;
  }): Promise<SignInSyncResponse> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findFirst({
      where: input.googleSub ? { OR: [{ googleId: input.googleSub }, { email }] } : { email },
    });

    if (existing) {
      // BE-037 — link Google to a matching credentials account on first Google login.
      const data: Record<string, unknown> = {};
      if (input.googleSub && !existing.googleId) data.googleId = input.googleSub;
      if (input.name && !existing.name) data.name = input.name;
      if (input.image && !existing.image) data.image = input.image;
      // Google verifies the email; adopt that if we hadn't verified it locally.
      if (!existing.emailVerifiedAt && input.googleSub) data.emailVerifiedAt = new Date();
      const user =
        Object.keys(data).length > 0
          ? await this.prisma.user.update({ where: { id: existing.id }, data })
          : existing;
      return this.syncResponse(user, false);
    }

    // First-time Google user — invite-only gate (§4.2).
    if (!input.inviteCode) {
      return {
        userId: '',
        email,
        role: 'operator',
        emailVerified: false,
        twoFactorEnabled: false,
        requiresInvite: true,
      };
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const invite = (await tx.inviteCode.findUnique({
        where: { code: input.inviteCode },
      })) as InviteRow | null;
      const verdict = checkInvite(invite, { email });
      if (!verdict.ok || !invite) {
        return null;
      }
      const created = await tx.user.create({
        data: {
          email,
          name: input.name ?? null,
          image: input.image ?? null,
          googleId: input.googleSub,
          emailVerifiedAt: new Date(), // Google-verified
        },
      });
      await tx.inviteCode.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      });
      await tx.inviteRedemption.create({
        data: { inviteCodeId: invite.id, userId: created.id },
      });
      return created;
    });

    if (!user) {
      return {
        userId: '',
        email,
        role: 'operator',
        emailVerified: false,
        twoFactorEnabled: false,
        requiresInvite: true,
      };
    }
    return this.syncResponse(user, false);
  }

  private syncResponse(
    user: {
      id: string;
      email: string;
      role: UserRole;
      emailVerifiedAt: Date | null;
      totpSecret: string | null;
      twoFactorEnabledAt: Date | null;
    },
    requiresInvite: boolean,
  ): SignInSyncResponse {
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerifiedAt !== null,
      twoFactorEnabled: user.twoFactorEnabledAt !== null,
      requiresInvite,
    };
  }

  // ── BE-032 — email/password registration ───────────────────────────────────
  async register(input: {
    email: string;
    password: string;
    inviteCode: string;
    name?: string;
  }): Promise<RegisterResponse> {
    const email = input.email.toLowerCase();
    const invite = (await this.prisma.inviteCode.findUnique({
      where: { code: input.inviteCode },
    })) as InviteRow | null;
    const verdict = checkInvite(invite, { email });
    if (!verdict.ok || !invite) {
      // 422 without revealing whether the email exists (BE-032 AC).
      throw new AuthError(AUTH_ERROR.INVITE_INVALID, 422, 'Invalid or expired invite code');
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AuthError(AUTH_ERROR.EMAIL_TAKEN, 409, 'Email already registered');
    }

    const passwordHash = await hashPassword(input.password);
    const verify = createToken(this.env.AUTH_TOKEN_TTL_MIN);

    const user = await this.prisma.$transaction(async (tx) => {
      // Re-check invite inside the tx to avoid a race on the last use.
      const fresh = (await tx.inviteCode.findUnique({
        where: { id: invite.id },
      })) as InviteRow | null;
      if (!fresh || !checkInvite(fresh, { email }).ok) {
        throw new AuthError(AUTH_ERROR.INVITE_INVALID, 422, 'Invalid or expired invite code');
      }
      const created = await tx.user.create({
        data: { email, name: input.name ?? null, passwordHash },
      });
      await tx.inviteCode.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      });
      await tx.inviteRedemption.create({
        data: { inviteCodeId: invite.id, userId: created.id },
      });
      await tx.emailVerificationToken.create({
        data: {
          userId: created.id,
          tokenHash: verify.tokenHash,
          purpose: 'verify_email',
          expiresAt: verify.expiresAt,
        },
      });
      return created;
    });

    await this.email.send(verificationEmail(this.env.APP_BASE_URL, email, verify.token));
    return { userId: user.id, email, verificationRequired: true };
  }

  // ── BE-033 — credentials login (called by NextAuth authorize) ──────────────
  async login(input: { email: string; password: string }): Promise<LoginResponse> {
    const email = input.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Uniform failure — never reveal whether the email exists.
    if (!user?.passwordHash) {
      throw new AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 401, 'Invalid email or password');
    }
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      throw new AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 401, 'Invalid email or password');
    }
    if (user.status === 'suspended') {
      throw new AuthError(AUTH_ERROR.SUSPENDED, 403, 'Account suspended');
    }
    if (!user.emailVerifiedAt) {
      throw new AuthError(AUTH_ERROR.EMAIL_NOT_VERIFIED, 403, 'Email not verified');
    }
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabledAt !== null,
    };
  }

  // ── BE-034 — email verification + password reset ───────────────────────────
  async verifyEmail(token: string): Promise<void> {
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (row?.purpose !== 'verify_email') {
      throw new AuthError(AUTH_ERROR.INVALID_TOKEN, 400, 'Invalid verification token');
    }
    if (row.usedAt) return; // idempotent — already verified
    if (isExpired(row.expiresAt)) {
      throw new AuthError(AUTH_ERROR.TOKEN_EXPIRED, 410, 'Verification link expired');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  /** Always resolves (no user enumeration); emails a link only if the user exists. */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = rawEmail.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    const reset = createToken(this.env.AUTH_TOKEN_TTL_MIN);
    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: reset.tokenHash,
        purpose: 'password_reset',
        expiresAt: reset.expiresAt,
      },
    });
    await this.email.send(passwordResetEmail(this.env.APP_BASE_URL, email, reset.token));
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (row?.purpose !== 'password_reset' || row.usedAt) {
      throw new AuthError(AUTH_ERROR.INVALID_TOKEN, 400, 'Invalid reset token');
    }
    if (isExpired(row.expiresAt)) {
      throw new AuthError(AUTH_ERROR.TOKEN_EXPIRED, 410, 'Reset link expired');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      // A completed reset proves email ownership — verify if not already.
      this.prisma.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);
  }

  // ── BE-035 — invite CRUD ───────────────────────────────────────────────────
  async createInvite(input: InviteCreateRequest, createdById: string | null) {
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;
    const row = (await this.prisma.inviteCode.create({
      data: {
        code: generateInviteCode(),
        invitedEmail: input.invitedEmail?.toLowerCase() ?? null,
        maxUses: input.maxUses,
        expiresAt,
        createdById,
      },
    })) as InviteRow;
    return toInviteDto(row);
  }

  async listInvites() {
    const rows = (await this.prisma.inviteCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    })) as InviteRow[];
    return rows.map((r) => toInviteDto(r));
  }

  async revokeInvite(id: string) {
    const row = (await this.prisma.inviteCode
      .update({ where: { id }, data: { revokedAt: new Date() } })
      .catch(() => null)) as InviteRow | null;
    if (!row) throw new AuthError('NOT_FOUND', 404, 'Invite not found');
    return toInviteDto(row);
  }

  // ── BE-036 — TOTP 2FA enroll / verify / step-up ────────────────────────────
  async enroll2faStart(userId: string): Promise<TwoFactorEnrollStartResponse> {
    const user = await this.mustUser(userId);
    if (user.twoFactorEnabledAt) {
      throw new AuthError(AUTH_ERROR.TWO_FACTOR_ALREADY_ENABLED, 409, '2FA already enabled');
    }
    const enrollment = generateTotpEnrollment(this.env.TOTP_ISSUER, user.email);
    await this.prisma.user.update({
      where: { id: userId },
      // Store the sealed pending secret; enabled only after verify.
      data: { totpSecret: sealTotpSecret(enrollment.secretBase32, this.credKey) },
    });
    return { secret: enrollment.secretBase32, otpauthUrl: enrollment.otpauthUrl };
  }

  async enroll2faVerify(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.mustUser(userId);
    if (user.twoFactorEnabledAt) {
      throw new AuthError(AUTH_ERROR.TWO_FACTOR_ALREADY_ENABLED, 409, '2FA already enabled');
    }
    if (!user.totpSecret) {
      throw new AuthError(AUTH_ERROR.TWO_FACTOR_NOT_ENROLLED, 409, 'Start enrollment first');
    }
    const secret = openTotpSecret(user.totpSecret, this.credKey);
    if (!verifyTotp(secret, code, this.env.TOTP_ISSUER, user.email)) {
      throw new AuthError(AUTH_ERROR.TWO_FACTOR_INVALID, 400, 'Invalid 2FA code');
    }
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabledAt: new Date() },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);
    return { recoveryCodes: codes };
  }

  /**
   * Verify a TOTP or recovery code and consume the recovery code on use.
   * Shared by the step-up endpoint and the kill-switch verifier.
   */
  async verifyTwoFactor(
    userId: string,
    code: string,
  ): Promise<{ ok: boolean; usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
    const user = await this.mustUser(userId);
    if (!user.twoFactorEnabledAt || !user.totpSecret) {
      throw new AuthError(AUTH_ERROR.TWO_FACTOR_NOT_ENROLLED, 409, '2FA is not enabled');
    }
    const secret = openTotpSecret(user.totpSecret, this.credKey);
    if (verifyTotp(secret, code, this.env.TOTP_ISSUER, user.email)) {
      const remaining = await this.prisma.recoveryCode.count({
        where: { userId, usedAt: null },
      });
      return { ok: true, usedRecoveryCode: false, recoveryCodesRemaining: remaining };
    }
    // Fall back to recovery codes (single-use).
    const unused = await this.prisma.recoveryCode.findMany({
      where: { userId, usedAt: null },
    });
    for (const rc of unused) {
      if (await verifyRecoveryCode(rc.codeHash, code)) {
        await this.prisma.recoveryCode.update({
          where: { id: rc.id },
          data: { usedAt: new Date() },
        });
        return {
          ok: true,
          usedRecoveryCode: true,
          recoveryCodesRemaining: unused.length - 1,
        };
      }
    }
    return { ok: false, usedRecoveryCode: false, recoveryCodesRemaining: unused.length };
  }

  async twoFactorStatus(userId: string) {
    const user = await this.mustUser(userId);
    const remaining = user.twoFactorEnabledAt
      ? await this.prisma.recoveryCode.count({ where: { userId, usedAt: null } })
      : 0;
    return { enabled: user.twoFactorEnabledAt !== null, recoveryCodesRemaining: remaining };
  }

  // ── BE-037 — account settings ──────────────────────────────────────────────
  async getAccount(userId: string): Promise<AccountResponse> {
    const user = await this.mustUser(userId);
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      emailVerified: user.emailVerifiedAt !== null,
      googleLinked: user.googleId !== null,
      passwordSet: user.passwordHash !== null,
      twoFactorEnabled: user.twoFactorEnabledAt !== null,
    };
  }

  async changePassword(
    userId: string,
    input: { currentPassword?: string; newPassword: string },
  ): Promise<void> {
    const user = await this.mustUser(userId);
    if (user.passwordHash) {
      // Existing password → the current one must match (defence in depth; step-up already enforced).
      if (!input.currentPassword) {
        throw new AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 400, 'Current password required');
      }
      const ok = await verifyPassword(user.passwordHash, input.currentPassword);
      if (!ok) {
        throw new AuthError(AUTH_ERROR.INVALID_CREDENTIALS, 400, 'Current password is incorrect');
      }
    }
    // Google-only account setting a password (BE-037): no current password needed.
    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  private async mustUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError('NOT_FOUND', 404, 'User not found');
    return user;
  }
}
