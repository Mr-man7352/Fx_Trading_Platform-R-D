import type { UserRole } from '@fx/types';
import type { DefaultSession } from 'next-auth';

/** FE-030 — augment NextAuth's Session/JWT with our role + step-up fields. */
declare module 'next-auth' {
  interface Session {
    user: { id: string; role: UserRole } & DefaultSession['user'];
    stepUp2FAAt: string | null;
    twoFactorEnabled: boolean;
  }
  interface User {
    role?: UserRole;
    twoFactorEnabled?: boolean;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId: string;
    role: UserRole;
    twoFactorEnabled: boolean;
    stepUp2FAAt: string | null;
  }
}
