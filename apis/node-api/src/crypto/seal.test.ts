import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './seal.js';

const KEY = Buffer.alloc(32, 9);
const AAD = 'fx-totp-secret:v1';

describe('BE-036 seal — generic AES-256-GCM string envelope', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY, AAD);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(openSecret(sealed, KEY, AAD)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects a mismatched AAD (domain separation)', () => {
    const sealed = sealSecret('secret', KEY, AAD);
    expect(() => openSecret(sealed, KEY, 'fx-broker-credentials:v1')).toThrow();
  });

  it('rejects a wrong key', () => {
    const sealed = sealSecret('secret', KEY, AAD);
    expect(() => openSecret(sealed, Buffer.alloc(32, 1), AAD)).toThrow();
  });

  it('rejects an unknown version and a truncated body', () => {
    expect(() => openSecret('v2:abcd', KEY, AAD)).toThrow(/version/);
    expect(() => openSecret('v1:AAAA', KEY, AAD)).toThrow(/truncated/);
  });
});
