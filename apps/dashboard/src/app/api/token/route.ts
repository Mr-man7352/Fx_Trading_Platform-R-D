import { auth } from '@/auth';
import { mintApiToken } from '@/lib/mint-token';

/**
 * BE-030 — mint a short-lived API bearer for the current session. The browser
 * api-client calls this to authenticate requests to the Node API. The secret
 * stays server-side; only the signed token crosses to the client.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  const token = await mintApiToken({
    sub: session.user.id,
    email: session.user.email ?? '',
    role: session.user.role,
    stepUp2FAAt: session.stepUp2FAAt ?? null,
  });
  return Response.json({ token });
}
