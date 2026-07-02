'use client';

import type { FXSession } from '@fx/types';
import { useSession as useNextAuthSession } from 'next-auth/react';
import { useMemo } from 'react';
import { needsStepUp, parseFXSession } from './index.js';

/** FE-006 — typed wrapper over next-auth's useSession, narrowed to FXSession. */
export function useSession(): {
  session: FXSession | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
} {
  const { data, status } = useNextAuthSession();
  const session = useMemo(() => parseFXSession(data), [data]);
  return { session, status };
}

/** FE-006 — `needsStepUp` is true when stepUp2FAAt is stale (>15 min) for sensitive actions. */
export function useStepUp2FA(): { needsStepUp: boolean; session: FXSession | null } {
  const { session } = useSession();
  return { needsStepUp: needsStepUp(session), session };
}
