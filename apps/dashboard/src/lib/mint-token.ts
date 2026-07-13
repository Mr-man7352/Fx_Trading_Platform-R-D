import 'server-only';
import type { ApiTokenClaims } from '@fx/types';
import { SignJWT } from 'jose';

/**
 * BE-030 — mint the short-lived HS256 Bearer the Node API verifies. Signed with
 * the shared `NEXTAUTH_SECRET` so the API's `jose.jwtVerify` accepts it. Runs
 * server-side only (the secret never reaches the browser); the token is minted
 * per API burst and expires in 5 minutes.
 */
const TTL_SECONDS = 5 * 60;

function secretKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return new TextEncoder().encode(secret);
}

export function mintApiToken(claims: ApiTokenClaims): Promise<string> {
  return new SignJWT({
    email: claims.email,
    role: claims.role,
    stepUp2FAAt: claims.stepUp2FAAt,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey());
}
