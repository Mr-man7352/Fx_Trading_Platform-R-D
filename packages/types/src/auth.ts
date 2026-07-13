import { z } from 'zod';

/** §7.3 — application roles. Mirrors Prisma `UserRole`; keep in sync. */
export const UserRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type UserRole = z.infer<typeof UserRoleSchema>;

/**
 * FE-006 — typed session shared by dashboard and auth-client.
 * `stepUp2FAAt`: last successful TOTP step-up; stale after 15 min for sensitive ops.
 */
export const FXSessionSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullish(),
    image: z.url().nullish(),
  }),
  stepUp2FAAt: z.iso.datetime().nullable(),
  expires: z.iso.datetime(),
});
export type FXSession = z.infer<typeof FXSessionSchema>;

/** Step-up freshness window for sensitive actions (kill-switch, mode change). */
export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * BE-030 — claims carried by the HS256 Bearer token the dashboard mints (signed
 * with `NEXTAUTH_SECRET`) and the API verifies with `jose.jwtVerify`. Kept here
 * so both sides encode/decode the exact same shape.
 */
export const ApiTokenClaimsSchema = z.object({
  sub: z.string(),
  email: z.email(),
  role: UserRoleSchema,
  /** ISO of the last successful step-up 2FA, or null. */
  stepUp2FAAt: z.iso.datetime().nullable().default(null),
});
export type ApiTokenClaims = z.infer<typeof ApiTokenClaimsSchema>;

// ─── BE-030…037 — Auth API contracts ─────────────────────────────────────────
//
// Node-internal contracts (not registered in `contractSchemas` — Python never
// consumes them). Password rules are enforced here so FE and API agree.

/** Shared password policy: ≥12 chars, at least one letter and one digit. */
export const PasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

/** Error codes the frontend switches on (kept as consts so both sides agree). */
export const AUTH_ERROR = {
  INVALID_TOKEN: 'INVALID_TOKEN',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVITE_INVALID: 'INVITE_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TWO_FACTOR_INVALID: 'TWO_FACTOR_INVALID',
  TWO_FACTOR_ALREADY_ENABLED: 'TWO_FACTOR_ALREADY_ENABLED',
  TWO_FACTOR_NOT_ENROLLED: 'TWO_FACTOR_NOT_ENROLLED',
  STEP_UP_2FA_REQUIRED: 'STEP_UP_2FA_REQUIRED',
  SUSPENDED: 'SUSPENDED',
} as const;

/** BE-031 — server-to-server user upsert on Google sign-in (`INTERNAL_SYNC_TOKEN`). */
export const SignInSyncRequestSchema = z.object({
  email: z.email(),
  googleSub: z.string().min(1).optional(),
  name: z.string().max(200).nullish(),
  image: z.url().nullish(),
  /**
   * Optional invite code for a first-time Google user (invite-only §4.2). When
   * the email has no account: a valid code creates+links the account, an
   * absent/invalid code returns `requiresInvite: true` and creates nothing.
   */
  inviteCode: z.string().min(1).optional(),
});
export type SignInSyncRequest = z.infer<typeof SignInSyncRequestSchema>;

export const SignInSyncResponseSchema = z.object({
  userId: z.string(),
  email: z.email(),
  role: UserRoleSchema,
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  /** First-time Google user with no matching account and no consumed invite. */
  requiresInvite: z.boolean(),
});
export type SignInSyncResponse = z.infer<typeof SignInSyncResponseSchema>;

/** BE-032 — email/password registration (requires a valid invite code). */
export const RegisterRequestSchema = z.object({
  email: z.email(),
  password: PasswordSchema,
  inviteCode: z.string().min(1),
  name: z.string().max(200).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  userId: z.string(),
  email: z.email(),
  /** Always true on success — a verification email was dispatched (BE-034). */
  verificationRequired: z.literal(true),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/** BE-033 — Credentials-provider login endpoint (called by NextAuth authorize). */
export const LoginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  userId: z.string(),
  email: z.email(),
  name: z.string().nullable(),
  image: z.url().nullable(),
  role: UserRoleSchema,
  twoFactorEnabled: z.boolean(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** BE-034 — email verification + password reset. */
export const VerifyEmailQuerySchema = z.object({ token: z.string().min(1) });
export type VerifyEmailQuery = z.infer<typeof VerifyEmailQuerySchema>;

export const RequestPasswordResetSchema = z.object({ email: z.email() });
export type RequestPasswordReset = z.infer<typeof RequestPasswordResetSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: PasswordSchema,
});
export type ResetPassword = z.infer<typeof ResetPasswordSchema>;

/** Generic ok envelope for flows that must not leak existence (BE-032/034). */
export const AuthOkResponseSchema = z.object({ ok: z.literal(true) });
export type AuthOkResponse = z.infer<typeof AuthOkResponseSchema>;

/** BE-035 — invite code CRUD (admin-only). */
export const InviteCreateRequestSchema = z.object({
  invitedEmail: z.email().optional(),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
export type InviteCreateRequest = z.infer<typeof InviteCreateRequestSchema>;

export const InviteCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  invitedEmail: z.string().nullable(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  createdById: z.string().nullable(),
  /** Derived: false once maxed, expired, or revoked. */
  active: z.boolean(),
});
export type InviteCode = z.infer<typeof InviteCodeSchema>;

export const InviteListResponseSchema = z.object({ invites: z.array(InviteCodeSchema) });
export type InviteListResponse = z.infer<typeof InviteListResponseSchema>;

/** BE-036 — TOTP 2FA enrollment. Step 1 returns the shared secret + otpauth URI. */
export const TwoFactorEnrollStartResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TwoFactorEnrollStartResponse = z.infer<typeof TwoFactorEnrollStartResponseSchema>;

/** BE-036 — a 6-digit TOTP code (also accepts an 8-char recovery code path). */
export const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

export const TwoFactorEnrollVerifyRequestSchema = z.object({ code: TotpCodeSchema });
export type TwoFactorEnrollVerifyRequest = z.infer<typeof TwoFactorEnrollVerifyRequestSchema>;

/** BE-036 — enrollment completion returns the 10 single-use recovery codes ONCE. */
export const TwoFactorEnrollCompleteResponseSchema = z.object({
  enabled: z.literal(true),
  recoveryCodes: z.array(z.string()).length(10),
});
export type TwoFactorEnrollCompleteResponse = z.infer<typeof TwoFactorEnrollCompleteResponseSchema>;

/** BE-036 — step-up verification: a TOTP code OR a recovery code. */
export const TwoFactorVerifyRequestSchema = z.object({
  code: z.string().trim().min(6).max(20),
});
export type TwoFactorVerifyRequest = z.infer<typeof TwoFactorVerifyRequestSchema>;

export const TwoFactorVerifyResponseSchema = z.object({
  stepUp2FAAt: z.iso.datetime(),
  /** True when a recovery code was consumed; carries how many remain. */
  usedRecoveryCode: z.boolean(),
  recoveryCodesRemaining: z.number().int().min(0),
});
export type TwoFactorVerifyResponse = z.infer<typeof TwoFactorVerifyResponseSchema>;

export const TwoFactorStatusResponseSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesRemaining: z.number().int().min(0),
});
export type TwoFactorStatusResponse = z.infer<typeof TwoFactorStatusResponseSchema>;

/** BE-037 — account settings: profile + change password (step-up required). */
export const AccountResponseSchema = z.object({
  userId: z.string(),
  email: z.email(),
  name: z.string().nullable(),
  role: UserRoleSchema,
  emailVerified: z.boolean(),
  googleLinked: z.boolean(),
  passwordSet: z.boolean(),
  twoFactorEnabled: z.boolean(),
});
export type AccountResponse = z.infer<typeof AccountResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  /** Required only when a password is already set; omitted for Google-only accounts. */
  currentPassword: z.string().min(1).optional(),
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
