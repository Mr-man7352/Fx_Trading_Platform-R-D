'use client';

import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from '@fx/ui';
import { useKillSwitch, useSignals } from '@/lib/hooks';

/**
 * FE-042 — system-health strip. Surfaces the v2.2 resilience machinery so the
 * operator can VERIFY safety systems are armed, not assume it.
 *
 * Real today: kill-switch state (Postgres source of truth, BE-073) and the
 * `model_downgraded` flag (derived from the agent-run summaries on `/signals`,
 * BE-067). Seams — gRPC circuit state (BE-068 exposes it internally; no JSON
 * read endpoint yet) and per-instrument session/liquidity regime (QN-041/047,
 * currently only inside the signal pipeline) — render with a clearly-labelled
 * "awaiting feed" state rather than a fabricated value.
 */

type Pill = { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'idle' };

const TONE: Record<Pill['tone'], string> = {
  ok: 'border-profit/40 bg-profit/10 text-profit',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  bad: 'border-destructive/50 bg-destructive/10 text-destructive',
  idle: 'border-border bg-muted/40 text-muted-foreground',
};

function StatusPill({ pill }: { pill: Pill }) {
  return (
    <div className={cn('rounded-md border px-3 py-2', TONE[pill.tone])}>
      <p className="text-[10px] font-medium uppercase tracking-wide opacity-80">{pill.label}</p>
      <p className="font-mono text-sm font-semibold">{pill.value}</p>
    </div>
  );
}

export function HealthStrip() {
  const killSwitch = useKillSwitch();
  const signals = useSignals({ limit: 20 });

  const ks = killSwitch.data?.state;
  const ksPill: Pill = ks?.active
    ? { label: 'Kill-switch', value: `HALTED · ${ks.closeOutStatus ?? 'closing'}`, tone: 'bad' }
    : killSwitch.isError
      ? { label: 'Kill-switch', value: 'no feed', tone: 'idle' }
      : { label: 'Kill-switch', value: 'ARMED · ready', tone: 'ok' };

  const anyDowngraded = (signals.data?.signals ?? []).some((s) => s.agents.anyDowngraded);
  const downgradePill: Pill = anyDowngraded
    ? { label: 'Model status', value: 'DOWNGRADED', tone: 'warn' }
    : { label: 'Model status', value: 'nominal', tone: 'ok' };

  // Seams — no JSON read endpoint on this instance yet.
  const circuitPill: Pill = { label: 'gRPC breaker', value: 'awaiting feed', tone: 'idle' };
  const sessionPill: Pill = { label: 'Session / liquidity', value: 'awaiting feed', tone: 'idle' };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">System health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatusPill pill={ksPill} />
          <StatusPill pill={circuitPill} />
          <StatusPill pill={sessionPill} />
          <StatusPill pill={downgradePill} />
        </div>
        {ks?.active && (
          <p className="mt-3 text-xs text-muted-foreground">
            Halted{ks.reason ? ` — “${ks.reason}”` : ''}
            {ks.activatedBy ? ` by ${ks.activatedBy}` : ''}
            {ks.activatedAt ? ` at ${new Date(ks.activatedAt).toLocaleString()}` : ''}.
          </p>
        )}
        <p className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">gap-flatten arming: per-position (see Trades)</Badge>
          <Badge variant="outline">partial-fill notices: via toasts (FE-120)</Badge>
        </p>
      </CardContent>
    </Card>
  );
}
