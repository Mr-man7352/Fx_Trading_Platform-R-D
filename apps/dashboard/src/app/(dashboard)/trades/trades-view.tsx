'use client';

import type { Trade } from '@fx/types';
import { Badge, Button, Card, CardContent, cn } from '@fx/ui';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useTrades } from '@/lib/hooks';

/**
 * FE-070 — trades history with provenance. Reads the typed trades endpoint
 * (BE-054 seam — the execution surface exposes the draft `Trade` shape today).
 * Rows expand to the provenance block (agent run, supervisor decisions, swap
 * P&L); the R-multiple / trailing status render once the richer trade record
 * lands. CSV export works over whatever the endpoint returns.
 */
export function TradesView() {
  const trades = useTrades();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = trades.data?.trades ?? [];

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportCsv() {
    const header = ['id', 'instrument', 'side', 'units', 'mode', 'openedAt', 'closedAt'];
    const lines = rows.map((t) =>
      [t.id, t.instrument, t.side, t.units, t.mode, t.openedAt, t.closedAt ?? ''].join(','),
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (trades.isError) return <ErrorState error={trades.error} />;
  if (trades.isLoading) return <LoadingRows rows={6} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No trades yet"
        description="Filled orders appear here with full provenance once the platform executes (paper or live)."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      {/* FE-130 — mobile (<sm): stacked cards, SL/TP + unrealized P&L visible
          without horizontal scroll (values arrive with the richer BE-054
          record; rendered as honest seams until then, never fabricated). */}
      <div className="space-y-2 sm:hidden">
        {rows.map((t) => (
          <MobileTradeCard key={t.id} trade={t} />
        ))}
      </div>

      <Card className="hidden sm:block">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Instrument</th>
                <th className="p-3 font-medium">Side</th>
                <th className="p-3 text-right font-medium">Units</th>
                <th className="p-3 font-medium">Mode</th>
                <th className="p-3 font-medium">Opened</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TradeRow
                  key={t.id}
                  trade={t}
                  open={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** FE-130 — one position per card: side/units/SL/TP/uP&L in a 2-col grid. */
function MobileTradeCard({ trade: t }: { trade: Trade }) {
  const isOpen = t.closedAt === null;
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm font-semibold">{t.instrument}</span>
          <Badge variant={isOpen ? 'default' : 'secondary'}>{isOpen ? 'open' : 'closed'}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Side</dt>
            <dd className="uppercase">{t.side}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Units</dt>
            <dd className="tabular-nums">{t.units.toLocaleString()}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">SL / TP</dt>
            <dd className="font-mono" title="Arrives with the richer BE-054 trade record">
              — / —
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Unrealized P&L</dt>
            <dd className="font-mono" title="Arrives with the richer BE-054 trade record">
              —
            </dd>
          </div>
          <div className="col-span-2 flex justify-between">
            <dt className="text-muted-foreground">Opened</dt>
            <dd className="tabular-nums">{new Date(t.openedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function TradeRow({
  trade: t,
  open,
  onToggle,
}: {
  trade: Trade;
  open: boolean;
  onToggle: () => void;
}) {
  const isOpen = t.closedAt === null;
  return (
    <>
      <tr
        className={cn(
          'cursor-pointer border-b transition-colors hover:bg-accent/20',
          open && 'bg-accent/10',
        )}
        onClick={onToggle}
      >
        <td className="p-3 font-mono">
          {/* FE-131 — keyboard-reachable expander (the row onClick is pointer sugar). */}
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${t.instrument} ${t.side} — toggle provenance details`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="font-mono underline-offset-2 hover:underline"
          >
            {t.instrument}
          </button>
        </td>
        <td className="p-3 uppercase">{t.side}</td>
        <td className="p-3 text-right tabular-nums">{t.units.toLocaleString()}</td>
        <td className="p-3">{t.mode}</td>
        <td className="p-3 tabular-nums">{new Date(t.openedAt).toLocaleString()}</td>
        <td className="p-3">
          <Badge variant={isOpen ? 'default' : 'secondary'}>{isOpen ? 'open' : 'closed'}</Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-card/40">
          <td colSpan={6} className="p-4 text-xs text-muted-foreground">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <span className="font-medium text-foreground">Trade id</span>
                <p className="font-mono">{t.id}</p>
              </div>
              <div>
                <span className="font-medium text-foreground">Closed</span>
                <p className="font-mono">
                  {t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}
                </p>
              </div>
              <div>
                <span className="font-medium text-foreground">R-multiple / trailing</span>
                <p>arrives with the richer trade record</p>
              </div>
            </div>
            <p className="mt-3">
              Agent runs, supervisor decisions, and swap P&L replay from this trade's provenance ids
              — surfaced here once the execution record exposes them (BE-054).
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
