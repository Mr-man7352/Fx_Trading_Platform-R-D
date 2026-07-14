'use client';

import type { LivePromotionCheck, RiskSettings } from '@fx/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@fx/ui';
import { type ComponentProps, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ErrorState, LoadingRows } from '@/components/states';
import {
  useLivePromotion,
  useLivePromotionRequest,
  useSettings,
  useSettingsMutation,
} from '@/lib/hooks';

/**
 * FE-100 — operator settings, now PERSISTED through BE-100 (Step 5.3): reads
 * the effective document (version + updatedAt shown), PATCHes a validated
 * partial, and the workers pick the new values up next cycle. Client-side
 * range checks mirror the authoritative `@fx/types` RiskSettingsSchema — the
 * server re-validates every write. Live promotion renders the real BE-101
 * checklist; the request path demands step-up 2FA (403 → step-up modal).
 */

/** [min, max] bounds mirroring RiskSettingsSchema (authoritative server-side). */
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

export function SettingsView() {
  const settings = useSettings();
  const mutation = useSettingsMutation();
  const { register, handleSubmit, reset } = useForm<RiskSettings>();

  // Populate the form from the server's effective document once loaded.
  useEffect(() => {
    if (settings.data) reset(settings.data.settings.risk);
  }, [settings.data, reset]);

  if (settings.isError) return <ErrorState error={settings.error} />;
  if (settings.isLoading || !settings.data) return <LoadingRows rows={5} />;

  const { version, updatedAt } = settings.data;

  async function onSubmit(raw: RiskSettings) {
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
    try {
      const res = await mutation.mutateAsync({ risk: numeric });
      toast.success(`Settings saved (v${res.version})`, {
        description: 'Workers pick the new values up on the next signal cycle.',
      });
    } catch (err) {
      toast.error('Save failed', {
        description: err instanceof Error ? err.message : 'Retry.',
      });
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Effective version <span className="font-mono">v{version}</span>
        {updatedAt && <> · last changed {new Date(updatedAt).toLocaleString()}</>}
        {version === 0 && <> · compiled defaults (no operator override yet)</>}
      </p>

      <LivePromotionCard />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Correlation clustering</CardTitle>
            <CardDescription>
              Consumes QN-048 clusters; cap enforced by BE-071. Python reads these knobs on its next
              scheduled pass.
            </CardDescription>
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
            <CardDescription>
              Entry-gate pre-filter, per-instrument tripwire, and debate depths take effect on the
              NEXT signal cycle (BE-100 AC).
            </CardDescription>
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

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </form>
    </div>
  );
}

/** BE-101 — the real promotion checklist; unmet conditions listed verbatim. */
function LivePromotionCard() {
  const checklist = useLivePromotion();
  const request = useLivePromotionRequest();
  const items: LivePromotionCheck[] = checklist.data?.checklist ?? [];
  const allowed = checklist.data?.allowed ?? false;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Mode &amp; promotion</CardTitle>
        <CardDescription>
          Promoting to <span className="font-mono">live</span> requires step-up 2FA and every BE-101
          condition below. <span className="font-mono">TRADING_MODE</span> itself flips at deploy —
          an approved request is recorded in the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {checklist.isLoading && <LoadingRows rows={3} />}
        {checklist.isError && <ErrorState error={checklist.error} />}
        {items.length > 0 && (
          <ul className="space-y-1.5">
            {items.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <Badge
                  variant={c.ok ? 'secondary' : 'destructive'}
                  className="mt-0.5 w-14 justify-center font-mono text-[10px]"
                >
                  {c.ok ? 'MET' : 'UNMET'}
                </Badge>
                <div>
                  <p>{c.label}</p>
                  {c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="destructive"
          disabled={request.isPending || checklist.isLoading}
          onClick={async () => {
            try {
              const res = await request.mutateAsync();
              if (res.allowed) {
                toast.success('Live promotion approved', {
                  description: 'Recorded in the audit log. Flip TRADING_MODE=live at deploy.',
                });
              } else {
                toast.error('Live promotion blocked', {
                  description: `${res.checklist.filter((c) => !c.ok).length} unmet condition(s) — see checklist.`,
                });
              }
            } catch (err) {
              // 403 STEP_UP_2FA_REQUIRED opens the step-up modal via the api client.
              toast.error('Promotion request failed', {
                description: err instanceof Error ? err.message : 'Retry.',
              });
            }
          }}
        >
          {allowed ? 'Request live promotion' : 'Request live promotion (will be blocked)'}
        </Button>
      </CardContent>
    </Card>
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
