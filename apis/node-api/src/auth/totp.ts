import * as OTPAuth from 'otpauth';
import { openSecret, sealSecret } from '../crypto/seal.js';

/**
 * BE-036 — TOTP (RFC 6238) enrollment + verification. The base32 secret is
 * sealed with the platform credentials key (AES-256-GCM, AAD below) exactly
 * like broker creds, so the DB never holds a usable secret. Verification
 * allows a ±1 step window (30s period) to tolerate clock skew.
 */

const TOTP_AAD = 'fx-totp-secret:v1';
const PERIOD = 30;
const DIGITS = 6;

function buildTotp(secretBase32: string, issuer: string, account: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer,
    label: account,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export interface TotpEnrollment {
  /** base32 secret — sealed before storage, returned in the clear ONCE for the QR. */
  secretBase32: string;
  otpauthUrl: string;
}

/** Generate a fresh secret + provisioning URI for the authenticator app. */
export function generateTotpEnrollment(issuer: string, account: string): TotpEnrollment {
  const secret = new OTPAuth.Secret({ size: 20 }); // 160-bit, RFC-recommended
  const totp = buildTotp(secret.base32, issuer, account);
  return { secretBase32: secret.base32, otpauthUrl: totp.toString() };
}

/** True when `code` is valid for the secret within the skew window. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  issuer: string,
  account: string,
): boolean {
  const totp = buildTotp(secretBase32, issuer, account);
  // validate() returns the time-step delta (number) or null when invalid.
  return totp.validate({ token: code.trim(), window: 1 }) !== null;
}

export function sealTotpSecret(secretBase32: string, key: Buffer): string {
  return sealSecret(secretBase32, key, TOTP_AAD);
}

export function openTotpSecret(envelope: string, key: Buffer): string {
  return openSecret(envelope, key, TOTP_AAD);
}
