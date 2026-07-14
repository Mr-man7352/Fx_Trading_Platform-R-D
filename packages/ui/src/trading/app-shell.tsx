import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * FE-011 — <AppShell>: shared dashboard chrome. Slot-based and server-component
 * friendly (no hooks) — pages compose it with <ModeBadge>, <KillSwitchButton>,
 * nav links, etc. Layout: sticky header, optional banner (FE-110), sidebar
 * (hidden <768px), content, and a mobile-only sticky footer so safety controls
 * stay one tap away (FE-130).
 */
export interface AppShellProps extends ComponentProps<'div'> {
  /** Brand/logo area, top-left. */
  brand?: ReactNode;
  /** Right side of the header — typically <ModeBadge> + <KillSwitchButton>. */
  headerRight?: ReactNode;
  /** Full-width strip under the header — typically <DisclaimerBanner> (FE-110). */
  banner?: ReactNode;
  /** Sidebar navigation (desktop only; mobile nav lives in `mobileFooter`). */
  sidebar?: ReactNode;
  /** Mobile sticky footer — kill switch must be reachable here in one tap (FE-130). */
  mobileFooter?: ReactNode;
  /**
   * FE-131 — render a "Skip to content" link as the first tabbable element
   * (WCAG 2.4.1 bypass blocks). Targets the main region (#main-content).
   */
  skipLink?: boolean;
}

export function AppShell({
  brand,
  headerRight,
  banner,
  sidebar,
  mobileFooter,
  skipLink = false,
  className,
  children,
  ...props
}: AppShellProps) {
  return (
    <div
      className={cn('flex min-h-dvh flex-col bg-background text-foreground', className)}
      {...props}
    >
      {skipLink && (
        <a
          href="#main-content"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
      )}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">{brand}</div>
          <div className="flex shrink-0 items-center gap-3">{headerRight}</div>
        </div>
      </header>
      {banner}
      <div className="flex flex-1">
        {sidebar && (
          <aside className="hidden w-56 shrink-0 border-r md:block">
            <nav aria-label="Primary" className="sticky top-14 flex flex-col gap-1 p-3">
              {sidebar}
            </nav>
          </aside>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className={cn('min-w-0 flex-1 p-4 outline-none md:p-6', mobileFooter && 'pb-20 md:pb-6')}
        >
          {children}
        </main>
      </div>
      {mobileFooter && (
        <footer className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur md:hidden">
          <div className="flex h-16 items-center justify-around gap-2 px-4">{mobileFooter}</div>
        </footer>
      )}
    </div>
  );
}
