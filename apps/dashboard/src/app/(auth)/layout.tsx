import { DisclaimerBanner } from '@fx/ui';
import type { ReactNode } from 'react';

/** FE-030…036 — centered shell for the auth flows (invite-only messaging + CFD disclaimer). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <DisclaimerBanner />
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <span className="font-mono text-sm font-bold tracking-wider">FX PLATFORM</span>
            <p className="mt-1 text-xs text-muted-foreground">
              Invite-only · own broker account only
            </p>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
