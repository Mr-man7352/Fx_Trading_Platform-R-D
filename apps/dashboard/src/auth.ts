import { LoginResponseSchema, type SignInSyncResponse, type UserRole } from '@fx/types';
import type { NextAuthConfig } from 'next-auth';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { API_BASE_URL } from './lib/api-base';

/**
 * FE-030…032 — NextAuth v5. Two providers, one session shape:
 *   - Google — after OAuth we call `POST /auth/sign-in-sync` (BE-031) to upsert
 *     the local user; an un-invited first-time Google user is denied (§4.2).
 *   - Credentials — email/password verified by `POST /auth/login` (BE-033).
 *
 * The JWT carries `userId`, `role`, `twoFactorEnabled`, `stepUp2FAAt`; the last
 * is refreshed via `useSession().update()` after a step-up (BE-036). The API
 * bearer is minted separately (`/api/token`) from these claims.
 */

async function syncGoogleUser(input: {
  email: string;
  googleSub: string;
  name?: string | null;
  image?: string | null;
}): Promise<SignInSyncResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/auth/sign-in-sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-sync-token': process.env.INTERNAL_SYNC_TOKEN ?? '',
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return (await res.json()) as SignInSyncResponse;
  } catch {
    return null;
  }
}

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/sign-in' },
  providers: [
    Google({ allowDangerousEmailAccountLinking: true }),
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = String(raw?.email ?? '');
        const password = String(raw?.password ?? '');
        if (!email || !password) return null;
        const res = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        // Any non-2xx (bad credentials, unverified email, suspended) → clean
        // CredentialsSignin. The sign-in page surfaces a uniform message.
        if (!res.ok) return null;
        const user = LoginResponseSchema.parse(await res.json());
        return {
          id: user.userId,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
          twoFactorEnabled: user.twoFactorEnabled,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google') return true;
      const email = user.email ?? (profile?.email as string | undefined);
      const sub = account.providerAccountId;
      if (!email || !sub) return false;
      const synced = await syncGoogleUser({
        email,
        googleSub: sub,
        name: user.name,
        image: user.image,
      });
      if (!synced) return false;
      if (synced.requiresInvite) return '/sign-in?error=InviteRequired';
      // Carry the synced identity onto the user so the jwt callback can persist it.
      user.id = synced.userId;
      (user as { role?: UserRole }).role = synced.role;
      (user as { twoFactorEnabled?: boolean }).twoFactorEnabled = synced.twoFactorEnabled;
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.userId = user.id as string;
        token.role = (user as { role?: UserRole }).role ?? 'operator';
        token.twoFactorEnabled = (user as { twoFactorEnabled?: boolean }).twoFactorEnabled ?? false;
        token.stepUp2FAAt = null;
      }
      // Refresh step-up after a successful /auth/2fa/verify (client update()).
      if (trigger === 'update' && session?.stepUp2FAAt !== undefined) {
        token.stepUp2FAAt = session.stepUp2FAAt as string | null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = (token.userId as string) ?? session.user.id;
      session.user.role = (token.role as UserRole) ?? 'operator';
      session.stepUp2FAAt = (token.stepUp2FAAt as string | null) ?? null;
      session.twoFactorEnabled = (token.twoFactorEnabled as boolean) ?? false;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
