import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openCredentials,
  parseEncryptionKey,
  redactToken,
  sealCredentials,
} from './credentials.js';

// BE-131 — seal/open round-trip, tamper detection, key validation.
describe('credential sealing', () => {
  const key = randomBytes(32);
  const payload = { apiToken: 'oanda-token-abc123', accountId: '101-004-1234567-001' };

  it('round-trips a payload', () => {
    const envelope = sealCredentials(payload, key);
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(openCredentials(envelope, key)).toEqual(payload);
  });

  it('produces a fresh IV per seal (no envelope reuse)', () => {
    expect(sealCredentials(payload, key)).not.toEqual(sealCredentials(payload, key));
  });

  it('never contains the plaintext token', () => {
    const envelope = sealCredentials(payload, key);
    expect(envelope).not.toContain(payload.apiToken);
    expect(Buffer.from(envelope.slice(3), 'base64').toString('utf8')).not.toContain(
      payload.apiToken,
    );
  });

  it('rejects tampered ciphertext', () => {
    const envelope = sealCredentials(payload, key);
    const buf = Buffer.from(envelope.slice(3), 'base64');
    const last = buf.length - 1;
    buf.writeUInt8(buf.readUInt8(last) ^ 0xff, last);
    expect(() => openCredentials(`v1:${buf.toString('base64')}`, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const envelope = sealCredentials(payload, key);
    expect(() => openCredentials(envelope, randomBytes(32))).toThrow();
  });

  it('rejects unknown versions and truncated envelopes', () => {
    expect(() => openCredentials('v9:AAAA', key)).toThrow(/version/);
    expect(() => openCredentials('v1:AAAA', key)).toThrow(/truncated/);
  });

  it('parseEncryptionKey enforces 32 bytes', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(randomBytes(32).toString('base64')).length).toBe(32);
  });

  it('redactToken keeps only edges', () => {
    expect(redactToken('oanda-token-abc123')).toBe('oand…c123');
    expect(redactToken('short')).toBe('••••');
  });
});
