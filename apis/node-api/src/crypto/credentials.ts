import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * BE-131 — broker credential sealing. AES-256-GCM envelope, versioned so the
 * format (and key) can rotate.
 *
 * Wire format (string, stored in broker_credentials.ciphertext):
 *   "v1:" + base64( iv[12] ‖ authTag[16] ‖ ciphertext )
 *   AAD = "fx-broker-credentials:v1"
 *   plaintext = UTF-8 JSON of BrokerCredentialPayload
 *
 * The format is deliberately language-neutral: the Python quant/worker runtime
 * decrypts with the same key using `cryptography.hazmat` AESGCM (iv = first 12
 * bytes, tag = next 16, rest = ciphertext; pass tag+ciphertext order per lib).
 * Key: CREDENTIALS_ENCRYPTION_KEY env — base64 of exactly 32 random bytes
 * (`openssl rand -base64 32`). Rotation bumps key_version on the row.
 */

const VERSION = 'v1';
const AAD = Buffer.from(`fx-broker-credentials:${VERSION}`, 'utf8');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Shape sealed into the envelope. Extend freely — it's opaque to the DB. */
export interface BrokerCredentialPayload {
  /** OANDA v20 personal access token (or MT5 login secret later). */
  apiToken: string;
  /** OANDA account id, e.g. "101-004-1234567-001". */
  accountId: string;
  [key: string]: unknown;
}

export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must be base64 of exactly 32 bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function sealCredentials(payload: BrokerCredentialPayload, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function openCredentials(envelope: string, key: Buffer): BrokerCredentialPayload {
  const [version, body] = envelope.split(':', 2);
  if (version !== VERSION || !body) {
    throw new Error(`Unsupported credential envelope version: ${version ?? '(none)'}`);
  }
  const buf = Buffer.from(body, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Credential envelope is truncated');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as BrokerCredentialPayload;
}

/** Constant-time comparison for token-ish strings (mirrors context.ts usage). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Redact a token for display/logs: first 4 + last 4 chars only ("never
 * returned in full to frontend" — BE-131 AC).
 */
export function redactToken(token: string): string {
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
