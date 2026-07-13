import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * BE-034 — signed-strength email verification + password-reset tokens. The
 * token is 32 bytes of entropy (base64url) mailed to the user; only its SHA-256
 * hash is stored, so a DB leak can't be used to verify/reset. High entropy
 * means a fast hash (not argon2) is appropriate — there is nothing to brute.
 */

export interface RawToken {
  /** Emailed to the user (never stored). */
  token: string;
  /** Stored in `email_verification_tokens.token_hash`. */
  tokenHash: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createToken(ttlMinutes: number, now: Date = new Date()): RawToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
  };
}

/** Constant-time hash comparison (defence-in-depth; the lookup is by hash anyway). */
export function tokenHashMatches(presentedToken: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presentedToken), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
