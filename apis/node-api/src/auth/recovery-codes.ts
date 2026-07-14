import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

/**
 * BE-036 — 10 single-use recovery codes issued at enrollment. Only argon2
 * hashes are stored; the plaintext set is shown to the operator exactly once.
 * A valid code satisfies step-up and is consumed on use (break-glass path when
 * the authenticator device is lost).
 */

const CODE_COUNT = 10;
// Crockford-ish base32 without ambiguous chars (no 0/O/1/I).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  // Grouped for readability: XXXXX-XXXXX
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: CODE_COUNT }, randomCode);
}

/** Normalise user input (case, whitespace, dashes) before hashing/compare. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, '');
}

export function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(normalizeRecoveryCode(code));
}

export function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map(hashRecoveryCode));
}

/** True when the presented code matches an unused stored hash. */
export function verifyRecoveryCode(storedHash: string, presented: string): Promise<boolean> {
  return verifyPassword(storedHash, normalizeRecoveryCode(presented));
}
