import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
} from './recovery-codes.js';

describe('BE-036 recovery codes', () => {
  it('generates 10 grouped codes from an unambiguous alphabet', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(c).not.toMatch(/[01OI]/);
    }
    expect(new Set(codes).size).toBe(10); // no collisions
  });

  it('normalizes case, whitespace, and dashes', () => {
    expect(normalizeRecoveryCode('  abcde-fghjk ')).toBe('ABCDEFGHJK');
  });

  it('hashes and verifies a code, tolerant of formatting', async () => {
    const [code] = generateRecoveryCodes();
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(hash, code.toLowerCase())).toBe(true);
    expect(await verifyRecoveryCode(hash, 'AAAAA-BBBBB')).toBe(false);
  });
});
