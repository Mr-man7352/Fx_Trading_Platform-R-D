import { hash, verify } from '@node-rs/argon2';

/**
 * BE-032/033 — password hashing (argon2id). OWASP-aligned parameters; the
 * verify path is constant-time inside the native lib. Kept in one place so the
 * cost parameters are auditable and can be tuned without touching handlers.
 */

// argon2id, 19 MiB, 2 passes, parallelism 1 (OWASP minimum for interactive login).
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTS);
}

/** Returns false (never throws) on a malformed/legacy hash — treat as wrong password. */
export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext);
  } catch {
    return false;
  }
}
