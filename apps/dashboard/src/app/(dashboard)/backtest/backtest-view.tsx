'use client';

import type { BacktestRun } from '@fx/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@fx/ui';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useBacktest, useBacktests } from '@/lib/hooks';
import { BacktestForm } from './backtest-form';

const STATUS_TONE: Record<string, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-warning/15 text-warning',
  finished: 'bg-profit/15 text-profit',
  failed: 'bg-destructive/15 text-destructive',
};

/** Pull a numeric metric out of the free-form engine report by candidate keys. */
function pickMetric(metrics: Record<string, unknown> | null, keys: string[]): string | null {
  if (!metrics) return null;
  const flat: Record<string, unknown> = { ...metrics };
  const nested = metrics.metrics ?? metrics.summary ?? metrics.oos;
  if (nested && typeof nested === 'object') Object.assign(flat, nested);
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  return null;
}

export function BacktestView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const backtests = useBacktests({ limit: 25 });
  // Realtime (`backtests` channel → invalidation + finished/failed toasts) is
  // owned by the layout-level RealtimeProvider (FE-120) — no page socket.

  const runs = backtests.data?.backtests ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
      <div className="space-y-4">
        <BacktestForm onCreated={setSelectedId} />
        <Card className="max-h-[50vh] overflow-auto">
          <CardHeader className="sticky top-0 bg-card pb-3">
            <CardTitle className="text-sm">Runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {backtests.isError ? (
              <ErrorState error={backtests.error} />
            ) : backtests.isLoading ? (
              <LoadingRows rows={4} />
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              runs.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    selectedId === r.id ? 'border-primary bg-accent/40' : 'hover:bg-accent/20',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{r.id.slice(0, 8)}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
                        STATUS_TONE[r.status],
                      )}
                    >
                      {r.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </p>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {selectedId ? (
        <BacktestDetail id={selectedId} />
      ) : (
        <EmptyState
          title="Select a run"
          description="Pick a run to see OOS metrics and ablations."
        />
      )}
    </div>
  );
}

function BacktestDetail({ id }: { id: string }) {
  const query = useBacktest(id);
  const run = query.data;
  if (query.isError) return <ErrorState error={query.error} />;
  if (query.isLoading || !run) return <LoadingRows rows={6} />;
  return <BacktestReport run={run} />;
}

function BacktestReport({ run }: { run: BacktestRun }) {
  const cfg = run.config as Record<string, unknown>;
  const mode = String(cfg.mode ?? 'quant-only');
  const kind = String(cfg.kind ?? 'quant');
  const reproducible = kind !== 'agentic' || mode === 'cached-llm' || mode === 'quant-only';
  const verdict = run.validationVerdict;

  const metricRows: [string, string[]][] = [
    ['Net return', ['totalReturn', 'net_return', 'return', 'pnl']],
    ['Sharpe', ['sharpe', 'sharpe_ratio']],
    ['Win rate', ['winRate', 'win_rate']],
    ['Max drawdown', ['maxDrawdown', 'max_drawdown']],
    ['Trades', ['trades', 'nTrades', 'num_trades']],
    ['vs baseline', ['baselineDelta', 'vs_baseline', 'excess_return']],
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="font-mono">
              {String(cfg.instrument ?? '')} · {kind} · {mode}
            </span>
            <span className="flex gap-2">
              <Badge variant={reproducible ? 'secondary' : 'destructive'}>
                {reproducible ? 'reproducible' : 'non-reproducible'}
              </Badge>
              {verdict && (
                <Badge variant={verdict === 'VALIDATED' ? 'default' : 'destructive'}>
                  {verdict}
                </Badge>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {run.status !== 'finished' ? (
            <p className="text-sm text-muted-foreground">
              Run is <span className="font-mono">{run.status}</span> — metrics appear when it
              finishes (progress streams over the backtests WS channel).
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {metricRows.map(([label, keys]) => {
                const value = pickMetric(run.metrics, keys);
                return (
                  <div key={label} className="rounded-md border p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                      {value ?? '—'}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {run.metrics && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Full engine report</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-md bg-background p-3 font-mono text-xs text-muted-foreground">
              {JSON.stringify(run.metrics, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
