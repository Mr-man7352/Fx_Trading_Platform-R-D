'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

/** FE-006 — client SessionProvider so `useSession()` works across the app. */
export function Providers({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
