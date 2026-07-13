import * as OTPAuth from 'otpauth';
import { describe, expect, it } from 'vitest';
import { generateTotpEnrollment, openTotpSecret, sealTotpSecret, verifyTotp } from './totp.js';

const KEY = Buffer.alloc(32, 3);
const ISSUER = 'FX Platform';
const ACCOUNT = 'ops@fx.local';

function currentCode(secretBase32: string): string {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: ACCOUNT,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

describe('BE-036 totp — enrollment + verification', () => {
  it('generates an otpauth URL and a verifiable code', () => {
    const { secretBase32, otpauthUrl } = generateTotpEnrollment(ISSUER, ACCOUNT);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain('FX%20Platform');
    const code = currentCode(secretBase32);
    expect(verifyTotp(secretBase32, code, ISSUER, ACCOUNT)).toBe(true);
    expect(verifyTotp(secretBase32, '000000', ISSUER, ACCOUNT)).toBe(false);
  });

  it('seals and re-opens the secret', () => {
    const { secretBase32 } = generateTotpEnrollment(ISSUER, ACCOUNT);
    const sealed = sealTotpSecret(secretBase32, KEY);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(openTotpSecret(sealed, KEY)).toBe(secretBase32);
  });
});
