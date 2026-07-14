'use client';

import type { SignalSummary } from '@fx/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@fx/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useSignals } from '@/lib/hooks';
import { useConnection } from '@/stores/connection';

/**
 * FE-060 — live agent debate viewer. Signals stream over the `signals` WS
 * channel (BE-067) — subscription, cache invalidation, and toasts are owned by
 * the layout-level RealtimeProvider (FE-120); this page reads the shared
 * connection status for its badge. The list + selected-signal detail read the
 * agent-cycle summary (roles that ran, LLM calls, cost, debate turns,
 * downgrade flag). A zero-cost `gate_skip` bar is shown explicitly. The FULL
 * per-role transcript + retrieved memories (§9.5) need the per-signal
 * provenance read that replays `agent_runs` — that endpoint is the remaining
 * seam; the summary is what BE-067 exposes today.
 */
export function AgentsView() {
  const params = useSearchParams();
  const preselect = params.get('signal');
  const signals = useSignals({ limit: 50 });
  const [selectedId, setSelectedId] = useState<string | null>(preselect);
  const wsStatus = useConnection((s) => s.status);

  const list = signals.data?.signals ?? [];
  const selected = list.find((s) => s.id === selectedId) ?? list[0] ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
      <Card className="max-h-[70vh] overflow-auto">
        <CardHeader className="sticky top-0 flex-row items-center justify-between gap-2 bg-card pb-3">
          <CardTitle className="text-sm">Cycles</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            ws {wsStatus}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {signals.isError ? (
            <ErrorState error={signals.error} />
          ) : signals.isLoading ? (
            <LoadingRows rows={6} />
          ) : list.length === 0 ? (
            <EmptyState
              title="No cycles yet"
              description="Signals appear as the H1 cycle fires. Needs a promoted champion with candidates."
            />
          ) : (
            list.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  selected?.id === s.id ? 'border-primary bg-accent/40' : 'hover:bg-accent/20',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{s.instrument}</span>
                  <span className="text-xs uppercase text-muted-foreground">{s.side}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{new Date(s.barTs).toLocaleString()}</span>
                  {s.agents.llmCalls === 0 && s.agents.costUsd === 0 ? (
                    <Badge variant="outline" className="text-[10px]">
                      gate skip
                    </Badge>
                  ) : (
                    <span className="tabular-nums">{s.agents.llmCalls} calls</span>
                  )}
                </div>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {selected ? <SignalDetail signal={selected} /> : <div />}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function SignalDetail({ signal: s }: { signal: SignalSummary }) {
  const gateSkip = s.agents.llmCalls === 0 && s.agents.costUsd === 0;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3 text-base">
            <span className="font-mono">
              {s.instrument} · {s.side.toUpperCase()} · {s.timeframe}
            </span>
            <Badge variant={s.status === 'rejected' ? 'destructive' : 'default'}>{s.status}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="P(profitable)"
            value={s.probability !== null ? `${(s.probability * 100).toFixed(1)}%` : '—'}
          />
          <Metric label="Entry" value={s.entryPrice !== null ? String(s.entryPrice) : '—'} />
          <Metric label="Stop" value={s.stopLoss !== null ? String(s.stopLoss) : '—'} />
          <Metric label="Target" value={s.takeProfit !== null ? String(s.takeProfit) : '—'} />
        </CardContent>
      </Card>

      {gateSkip ? (
        <Card>
          <CardContent className="p-4 text-sm">
            <Badge variant="outline" className="mb-2">
              gate_skip · zero LLM cost
            </Badge>
            <p className="text-muted-foreground">
              The deterministic entry gate skipped the agent graph for this bar (no candidate or P
              below the pre-filter, ADR-010). No provider calls were made — cost $0.00.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Agent cycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="LLM calls" value={String(s.agents.llmCalls)} />
              <Metric label="Cost" value={`$${s.agents.costUsd.toFixed(4)}`} />
              <Metric label="Debate turns" value={String(s.debateTurns)} />
              <Metric label="Downgraded" value={s.agents.anyDowngraded ? 'YES' : 'no'} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Roles that ran
              </p>
              <div className="flex flex-wrap gap-1.5">
                {s.agents.roles.map((r) => (
                  <Badge key={r} variant="secondary" className="font-mono text-[11px]">
                    {r}
                  </Badge>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Full per-role JSON, the debate transcript, and the retrieved memories each agent saw
              replay from stored <code>agent_runs</code> — that per-signal provenance read is the
              remaining backend seam for this view.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
