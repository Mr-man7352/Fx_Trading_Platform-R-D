import { TradingModeSchema } from '@fx/types';
import { AppShell, DisclaimerBanner, ModeBadge } from '@fx/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppNav, MobileNav } from '@/components/app-nav';
import { KillSwitch } from '@/components/kill-switch';
import { RealtimeProvider } from '@/components/realtime-provider';
import { StepUpGate } from '@/components/step-up-gate';
import { UserMenu } from '@/components/user-menu';

/**
 * FE-041 — the operator shell every dashboard page hangs off. Sidebar nav
 * (desktop) + condensed footer nav with the kill-switch always one tap away
 * (FE-130). The kill-switch, ModeBadge, and disclaimer (FE-110) live in the
 * chrome so they persist across routes. The step-up gate and the FE-120
 * realtime layer (one WS connection, toasts + reconnect banner) mount once
 * here. The skip link is the first tabbable element (FE-131 keyboard nav).
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const mode = TradingModeSchema.catch('paper').parse(process.env.TRADING_MODE);

  return (
    <AppShell
      skipLink
      brand={
        <Link href="/dashboard" className="font-mono text-sm font-bold tracking-wider">
          FX PLATFORM
        </Link>
      }
      headerRight={
        <>
          <ModeBadge mode={mode} />
          <div className="hidden md:block">
            <KillSwitch />
          </div>
          <UserMenu />
        </>
      }
      banner={<DisclaimerBanner />}
      sidebar={<AppNav />}
      mobileFooter={
        <>
          <MobileNav />
          <KillSwitch compact />
        </>
      }
    >
      {children}
      <StepUpGate />
      <RealtimeProvider />
    </AppShell>
  );
}
