'use client';

import { Button } from '@fx/ui';
import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';

/** FE-036 — minimal header affordance: account link + sign-out (full nav = FE-041). */
export function UserMenu() {
  const { data: session, status } = useSession();
  if (status !== 'authenticated') return null;
  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="ghost" size="sm">
        <Link href="/settings/account">{session.user.email ?? 'Account'}</Link>
      </Button>
      <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: '/sign-in' })}>
        Sign out
      </Button>
    </div>
  );
}
