'use client';

import { cn } from '@fx/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * FE-041 — primary navigation. Covers every operator surface; the active route
 * is highlighted from `usePathname`. Rendered in the AppShell sidebar (desktop)
 * and as a condensed row in the mobile sticky footer alongside the kill-switch.
 */
export const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', glyph: '◉' },
  { href: '/charts', label: 'Charts', glyph: '▤' },
  { href: '/agents', label: 'Agents', glyph: '⚖' },
  { href: '/trades', label: 'Trades', glyph: '⇄' },
  { href: '/backtest', label: 'Backtest', glyph: '↻' },
  { href: '/quant', label: 'Quant', glyph: '∿' },
  { href: '/calendar', label: 'Calendar', glyph: '▦' },
  { href: '/audit', label: 'Audit', glyph: '❑' },
  { href: '/settings', label: 'Settings', glyph: '⚙' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppNav() {
  const pathname = usePathname();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <span aria-hidden className="w-4 text-center font-mono text-base leading-none">
              {item.glyph}
            </span>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

/** FE-130 — condensed footer nav for phones (kill-switch lives beside it). */
export function MobileNav() {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) =>
    ['/dashboard', '/charts', '/agents', '/trades'].includes(i.href),
  );
  return (
    <>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-col items-center gap-0.5 text-[10px] font-medium',
              active ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span aria-hidden className="font-mono text-base leading-none">
              {item.glyph}
            </span>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
