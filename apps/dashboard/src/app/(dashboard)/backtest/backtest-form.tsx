'use client';

import { type BacktestConfig, BacktestConfigSchema } from '@fx/types';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@fx/ui';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCreateBacktest } from '@/lib/hooks';

/**
 * FE-080 — backtest config. Validated against the shared `BacktestConfigSchema`
 * (BE-090 / QN-052) before POST; agentic runs expose the three execution modes
 * and label reproducibility (cached-llm = reproducible, live-llm = not).
 */
interface FormValues {
  kind: 'quant' | 'agentic';
  instrument: string;
  timeframe: 'H1' | 'D1';
  from: string;
  to: string;
  probabilityThreshold: number;
  riskPct: number;
  initialEquity: number;
  runValidation: boolean;
  runAblations: boolean;
  mode: 'quant-only' | 'cached-llm' | 'live-llm';
  memoryEnabled: boolean;
}

const DEFAULTS: FormValues = {
  kind: 'quant',
  instrument: 'EUR_USD',
  timeframe: 'H1',
  from: '2024-01-01T00:00',
  to: '2024-07-01T00:00',
  probabilityThreshold: 0.6,
  riskPct: 0.01,
  initialEquity: 10_000,
  runValidation: true,
  runAblations: false,
  mode: 'quant-only',
  memoryEnabled: true,
};

export function BacktestForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [values, setValues] = useState<FormValues>(DEFAULTS);
  const [errors, setErrors] = useState<string[]>([]);
  const create = useCreateBacktest();
  const agentic = values.kind === 'agentic';

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    const parsed = BacktestConfigSchema.safeParse({
      ...values,
      from: new Date(values.from).toISOString(),
      to: new Date(values.to).toISOString(),
    });
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return;
    }
    try {
      const res = await create.mutateAsync(parsed.data as BacktestConfig);
      toast.success('Backtest queued', {
        description: `Run ${res.id.slice(0, 8)} · ${res.status}`,
      });
      onCreated(res.id);
    } catch (err) {
      toast.error('Could not start backtest', {
        description: err instanceof Error ? err.message : 'Retry.',
      });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">New run</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <select
                className="w-full rounded-md border bg-card px-2 py-1.5 text-sm"
                value={values.kind}
                onChange={(e) => set('kind', e.target.value as 'quant' | 'agentic')}
              >
                <option value="quant">quant</option>
                <option value="agentic">agentic</option>
              </select>
            </Field>
            <Field label="Instrument">
              <Input
                value={values.instrument}
                onChange={(e) => set('instrument', e.target.value)}
              />
            </Field>
            <Field label="From">
              <Input
                type="datetime-local"
                value={values.from}
                onChange={(e) => set('from', e.target.value)}
              />
            </Field>
            <Field label="To">
              <Input
                type="datetime-local"
                value={values.to}
                onChange={(e) => set('to', e.target.value)}
              />
            </Field>
            <Field label="P threshold">
              <Input
                type="number"
                step="0.01"
                value={values.probabilityThreshold}
                onChange={(e) => set('probabilityThreshold', Number(e.target.value))}
              />
            </Field>
            <Field label="Risk %">
              <Input
                type="number"
                step="0.001"
                value={values.riskPct}
                onChange={(e) => set('riskPct', Number(e.target.value))}
              />
            </Field>
          </div>

          {agentic && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode">
                <select
                  className="w-full rounded-md border bg-card px-2 py-1.5 text-sm"
                  value={values.mode}
                  onChange={(e) =>
                    set('mode', e.target.value as 'quant-only' | 'cached-llm' | 'live-llm')
                  }
                >
                  <option value="quant-only">quant-only</option>
                  <option value="cached-llm">cached-llm (reproducible)</option>
                  <option value="live-llm">live-llm (non-reproducible)</option>
                </select>
              </Field>
              <Field label="Memory">
                <select
                  className="w-full rounded-md border bg-card px-2 py-1.5 text-sm"
                  value={String(values.memoryEnabled)}
                  onChange={(e) => set('memoryEnabled', e.target.value === 'true')}
                >
                  <option value="true">enabled</option>
                  <option value="false">disabled</option>
                </select>
              </Field>
            </div>
          )}

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={values.runValidation}
                onChange={(e) => set('runValidation', e.target.checked)}
              />
              OOS validation
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={values.runAblations}
                onChange={(e) => set('runAblations', e.target.checked)}
              />
              Ablations
            </label>
          </div>

          {errors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}

          <Button type="submit" disabled={create.isPending} className="w-full">
            {create.isPending ? 'Starting…' : 'Run backtest'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
