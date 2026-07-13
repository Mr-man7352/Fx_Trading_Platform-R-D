import { type ApiTokenClaims, ApiTokenClaimsSchema } from '@fx/types';
import { errors, jwtVerify } from 'jose';

/**
 * BE-030 — verify the HS256 Bearer token the dashboard mints (signed with
 * `NEXTAUTH_SECRET`). `jose.jwtVerify` checks the signature and `exp`/`nbf`;
 * we then validate the claim shape with the shared Zod contract so a malformed
 * but correctly-signed token is still rejected.
 *
 * Distinct failure reasons let the middleware pick the right status:
 *   - `expired`  → 401 INVALID_TOKEN (client should refresh / re-auth)
 *   - `invalid`  → 401 INVALID_TOKEN (bad signature, malformed, wrong claims)
 */
export type VerifyResult =
  | { ok: true; claims: ApiTokenClaims; exp: number | null }
  | { ok: false; reason: 'expired' | 'invalid' };

export function makeSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function verifyAccessToken(token: string, key: Uint8Array): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    const parsed = ApiTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      claims: parsed.data,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    };
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}
