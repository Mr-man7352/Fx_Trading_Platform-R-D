'use client';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@fx/ui';
import type { ComponentProps } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

/**
 * FE-100 — operator settings. The v2.2 risk knobs are range-validated
 * client-side; the authoritative contract + persistence are the BE-100 CRUD
 * seam (Step 5.3), and a live promotion additionally requires step-up 2FA + the
 * BE-101 promotion gate (enforced server-side). Effective values show next to
 * their defaults. (The dashboard deliberately keeps zod out of its own deps —
 * the shared schema lands in `@fx/types` with BE-100.)
 */
interface RiskSettings {
  clusterLookbackDays: number;
  clusterThreshold: number;
  clusterCadenceHours: number;
  sessionMultLondon: number;
  sessionMultNewYork: number;
  sessionMultTokyo: number;
  weekendGapFlatten: boolean;
  perInstrumentDailyLossPct: number;
  debateRoundsLowEntropy: 0 | 1 | 2;
  debateRoundsHighEntropy: 0 | 1 | 2;
  entryGatePreFilter: number;
}

/** [min, max] bounds mirroring the intended BE-100 contract. */
const BOUNDS: Record<keyof RiskSettings, [number, number] | null> = {
  clusterLookbackDays: [5, 365],
  clusterThreshold: [0, 1],
  clusterCadenceHours: [1, 168],
  sessionMultLondon: [0.1, 5],
  sessionMultNewYork: [0.1, 5],
  sessionMultTokyo: [0.1, 5],
  weekendGapFlatten: null,
  perInstrumentDailyLossPct: [0.001, 0.1],
  debateRoundsLowEntropy: [0, 2],
  debateRoundsHighEntropy: [0, 2],
  entryGatePreFilter: [0.5, 0.95],
};

const DEFAULTS: RiskSettings = {
  clusterLookbackDays: 60,
  clusterThreshold: 0.6,
  clusterCadenceHours: 24,
  sessionMultLondon: 1,
  sessionMultNewYork: 1,
  sessionMultTokyo: 0.8,
  weekendGapFlatten: true,
  perInstrumentDailyLossPct: 0.02,
  debateRoundsLowEntropy: 0,
  debateRoundsHighEntropy: 2,
  entryGatePreFilter: 0.5,
};

export function SettingsView() {
  const { register, handleSubmit } = useForm<RiskSettings>({ defaultValues: DEFAULTS });

  function onSubmit(raw: RiskSettings) {
    const numeric: RiskSettings = {
      ...raw,
      clusterLookbackDays: Number(raw.clusterLookbackDays),
      clusterThreshold: Number(raw.clusterThreshold),
      clusterCadenceHours: Number(raw.clusterCadenceHours),
      sessionMultLondon: Number(raw.sessionMultLondon),
      sessionMultNewYork: Number(raw.sessionMultNewYork),
      sessionMultTokyo: Number(raw.sessionMultTokyo),
      perInstrumentDailyLossPct: Number(raw.perInstrumentDailyLossPct),
      debateRoundsLowEntropy: Number(raw.debateRoundsLowEntropy) as 0 | 1 | 2,
      debateRoundsHighEntropy: Number(raw.debateRoundsHighEntropy) as 0 | 1 | 2,
      entryGatePreFilter: Number(raw.entryGatePreFilter),
    };
    for (const [key, bound] of Object.entries(BOUNDS)) {
      if (!bound) continue;
      const value = numeric[key as keyof RiskSettings] as number;
      if (Number.isNaN(value) || value < bound[0] || value > bound[1]) {
        toast.error('Invalid settings', {
          description: `${key} must be between ${bound[0]} and ${bound[1]}.`,
        });
        return;
      }
    }
    toast.success('Validated', {
      description: 'Persistence lands with the BE-100 settings API (Step 5.3).',
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Mode &amp; promotion</CardTitle>
          <CardDescription>
            Promoting to <span className="font-mono">live</span> requires step-up 2FA and passes the
            BE-101 promotion gate (a <span className="font-mono">NOT VALIDATED</span> model is
            blocked server-side).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" disabled>
            Promote to live (gated)
          </Button>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Correlation clustering</CardTitle>
            <CardDescription>Consumes QN-048 clusters; cap enforced by BE-071.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <NumField
              label="Lookback (days)"
              hint="default 60"
              {...register('clusterLookbackDays')}
            />
            <NumField
              label="Threshold"
              hint="default 0.60"
              step="0.01"
              {...register('clusterThreshold')}
            />
            <NumField label="Cadence (h)" hint="default 24" {...register('clusterCadenceHours')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Session spread multipliers</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3">
            <NumField
              label="London"
              hint="default 1.0"
              step="0.1"
              {...register('sessionMultLondon')}
            />
            <NumField
              label="New York"
              hint="default 1.0"
              step="0.1"
              {...register('sessionMultNewYork')}
            />
            <NumField
              label="Tokyo"
              hint="default 0.8"
              step="0.1"
              {...register('sessionMultTokyo')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Limits &amp; gating</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <NumField
              label="Per-instrument daily loss"
              hint="default 0.02"
              step="0.001"
              {...register('perInstrumentDailyLossPct')}
            />
            <NumField
              label="Entry-gate pre-filter P"
              hint="default 0.50"
              step="0.01"
              {...register('entryGatePreFilter')}
            />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Weekend-gap flatten</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" {...register('weekendGapFlatten')} /> armed
              </label>
            </div>
            <SelectField
              label="Debate rounds (low entropy)"
              hint="default 0"
              {...register('debateRoundsLowEntropy')}
            />
            <SelectField
              label="Debate rounds (high entropy)"
              hint="default 2"
              {...register('debateRoundsHighEntropy')}
            />
          </CardContent>
        </Card>

        <Button type="submit">Save settings</Button>
      </form>
    </div>
  );
}

function NumField({
  label,
  hint,
  ...rest
}: ComponentProps<'input'> & { label: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input type="number" {...rest} />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SelectField({
  label,
  hint,
  ...rest
}: ComponentProps<'select'> & { label: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <select className="w-full rounded-md border bg-card px-2 py-1.5 text-sm" {...rest}>
        <option value={0}>0</option>
        <option value={1}>1</option>
        <option value={2}>2</option>
      </select>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
