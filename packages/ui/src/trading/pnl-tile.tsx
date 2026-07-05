import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/**
 * FE-011 — <PnLTile>: labelled P&L metric with direction colouring and an
 * optional stale-data indicator (FE-120 wires staleness from the WS layer).
 */

/** Sign-aware display string: +1,234.56 / −87.30 / 0.00 (exported for tests). */
export function formatSigned(value: number, fractionDigits = 2): string {
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

export function pnlDirection(value: number): 'profit' | 'loss' | 'flat' {
  if (value > 0) return 'profit';
  if (value < 0) return 'loss';
  return 'flat';
}

export interface PnLTileProps extends ComponentProps<'div'> {
  label: string;
  /** P&L in account currency. */
  value: number;
  currency?: string;
  /** Optional secondary metric, e.g. percentage return. */
  changePct?: number;
  /** True when the feed backing this tile is stale/disconnected (FE-120). */
  stale?: boolean;
}

export function PnLTile({
  label,
  value,
  currency = 'USD',
  changePct,
  stale = false,
  className,
  ...props
}: PnLTileProps) {
  const direction = pnlDirection(value);
  return (
    <div
      data-direction={direction}
      className={cn('rounded-lg border bg-card p-4 shadow-sm', stale && 'opacity-60', className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {stale && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-warning">
            STALE
          </span>
        )}
      </div>
      <p
        className={cn(
          'mt-1 font-mono text-2xl font-semibold tabular-nums',
          direction === 'profit' && 'text-profit',
          direction === 'loss' && 'text-loss',
        )}
      >
        {formatSigned(value)} <span className="text-sm text-muted-foreground">{currency}</span>
      </p>
      {changePct !== undefined && (
        <p
          className={cn(
            'mt-0.5 font-mono text-xs tabular-nums',
            changePct > 0 && 'text-profit',
            changePct < 0 && 'text-loss',
            changePct === 0 && 'text-muted-foreground',
          )}
        >
          {formatSigned(changePct)}%
        </p>
      )}
    </div>
  );
}
