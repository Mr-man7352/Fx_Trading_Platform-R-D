'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, PnLTile } from '@fx/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSignals } from '@/lib/hooks';
import { useWs } from '@/lib/use-ws';

/**
 * FE-040 — operator home. Equity / daily-P&L / open-positions tiles are fed by
 * the broker-equity seam (ACCOUNT_BASELINE_EQUITY + realized P&L; no JSON read
 * endpoint on this instance yet) so they render `stale` with a caption rather
 * than a fabricated number. The recent-signals tile and the live WS bridge are
 * real (BE-067/BE-014).
 */
export function Home() {
  const signals = useSignals({ limit: 10 });
  const qc = useQueryClient();

  const onEvent = useCallback(
    (channel: string, payload: unknown) => {
      if (channel === 'signals') {
        qc.invalidateQueries({ queryKey: ['signals'] });
      }
      if (channel.startsWith('risk')) {
        qc.invalidateQueries({ queryKey: ['kill-switch'] });
        const p = payload as { reason?: string } | undefined;
        if (channel.includes('halt')) {
          toast.error('Risk halt', { description: p?.reason ?? 'Trading paused.' });
        }
      }
    },
    [qc],
  );

  const status = useWs({ channels: ['signals', 'risk.halt', 'risk.resume'], onEvent });
  const recent = signals.data?.signals ?? [];
  const last = recent[0];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PnLTile label="Equity" value={0} stale />
        <PnLTile label="Daily P&L" value={0} stale />
        <PnLTile label="Open positions" value={0} stale />
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent signals
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{recent.length}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {last ? `${last.instrument} · ${last.status}` : 'none yet'} · ws {status}
            </p>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Equity, P&L and positions read the broker-equity seam (revisit before live, Phase 6); the
        agents-vs-baseline comparison lands with the QN-060 validator.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest cycles</CardTitle>
          <CardDescription>
            Most recent quant candidates and their agent-cycle summaries. Full transcripts on the{' '}
            <Link href="/agents" className="underline">
              Agents
            </Link>{' '}
            page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {recent.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No signals yet. They stream in as the H1 cycle fires (needs a promoted champion).
            </p>
          )}
          {recent.slice(0, 5).map((s) => (
            <Link
              key={s.id}
              href={`/agents?signal=${s.id}`}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-accent/40"
            >
              <span className="font-mono">{s.instrument}</span>
              <span className="uppercase text-muted-foreground">{s.side}</span>
              <span className="tabular-nums">
                {s.probability !== null ? `P ${(s.probability * 100).toFixed(0)}%` : '—'}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{s.status}</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
