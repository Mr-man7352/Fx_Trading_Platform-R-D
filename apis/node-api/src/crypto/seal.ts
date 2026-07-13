import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * BE-036 — generic AES-256-GCM string sealer, factored out of credentials.ts so
 * the TOTP secret can be sealed with the same key (CREDENTIALS_ENCRYPTION_KEY)
 * under its own AAD. Wire format matches the broker envelope byte-for-byte:
 *   "v1:" + base64( iv[12] ‖ authTag[16] ‖ ciphertext )
 * The AAD is caller-supplied so envelopes are domain-separated (a broker
 * envelope can never be opened as a TOTP secret and vice-versa).
 */

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function sealSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function openSecret(envelope: string, key: Buffer, aad: string): string {
  const [version, body] = envelope.split(':', 2);
  if (version !== VERSION || !body) {
    throw new Error(`Unsupported secret envelope version: ${version ?? '(none)'}`);
  }
  const buf = Buffer.from(body, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Secret envelope is truncated');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
