import type { TradingMode } from '@fx/types';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/**
 * FE-011 — <ModeBadge>: shows the current TRADING_MODE with colour coding.
 * backtest = blue (analysis), paper = amber (simulated), live = red (real money).
 */
export const MODE_BADGE_STYLES: Record<TradingMode, { label: string; className: string }> = {
  backtest: {
    label: 'BACKTEST',
    className: 'border-mode-backtest/50 bg-mode-backtest/15 text-mode-backtest',
  },
  paper: {
    label: 'PAPER',
    className: 'border-mode-paper/50 bg-mode-paper/15 text-mode-paper',
  },
  live: {
    label: 'LIVE',
    className: 'border-mode-live/60 bg-mode-live/15 text-mode-live',
  },
};

export interface ModeBadgeProps extends ComponentProps<'span'> {
  mode: TradingMode;
}

export function ModeBadge({ mode, className, ...props }: ModeBadgeProps) {
  const style = MODE_BADGE_STYLES[mode];
  return (
    <span
      data-mode={mode}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 font-mono text-xs font-bold tracking-wider',
        style.className,
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full bg-current', mode === 'live' && 'animate-pulse')}
      />
      {style.label}
    </span>
  );
}
