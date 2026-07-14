'use client';

import type { QuantModelEntry } from '@fx/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@fx/ui';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useQuantCalibration, useQuantModels, useQuantRegime } from '@/lib/hooks';

/**
 * FE-090 — quant analytics, wired end-to-end (Step 5.3/5.4 seam close):
 * model registry via `GET /quant/models`, calibration reliability via the
 * QN-055 Node proxy, regime timeline via `GET /quant/regime/:instrument`.
 * Empty/error surfaces stay calm and honest (404 = no such model artifact,
 * 422 = too few bars, 503 = quant service down). Curves are only worth
 * trusting after the ≥18-month retrain — the banner persists until a
 * champion carries real metrics.
 */

// Perfect-calibration reference diagonal.
const DIAGONAL = Array.from({ length: 11 }, (_, i) => ({ p: i / 10, ideal: i / 10 }));

/** Normalize the artifact's free-form reliability curve into plot points. */
function normalizeCurve(curve: unknown): Array<{ p: number; observed: number }> {
  if (!Array.isArray(curve)) return [];
  const points: Array<{ p: number; observed: number }> = [];
  for (const item of curve) {
    if (Array.isArray(item) && item.length >= 2) {
      const [p, observed] = item;
      if (typeof p === 'number' && typeof observed === 'number') points.push({ p, observed });
    } else if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      const p = r.predicted ?? r.mean_predicted ?? r.p;
      const o = r.observed ?? r.fraction_positive ?? r.freq;
      if (typeof p === 'number' && typeof o === 'number') points.push({ p, observed: o });
    }
  }
  return points.sort((a, b) => a.p - b.p);
}

const REGIME_COLOR: Record<string, string> = {
  TREND_UP: 'bg-profit',
  TREND_DOWN: 'bg-loss',
  RANGE: 'bg-warning',
};

export function QuantView() {
  const models = useQuantModels();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const list = models.data?.models ?? [];
  const selected: QuantModelEntry | null = useMemo(() => {
    if (list.length === 0) return null;
    if (selectedKey) {
      const found = list.find(
        (m) => `${m.instrument}/${m.timeframe}/v${m.version}` === selectedKey,
      );
      if (found) return found;
    }
    return list.find((m) => m.role === 'champion') ?? list[0] ?? null;
  }, [list, selectedKey]);

  const calibration = useQuantCalibration(
    selected
      ? {
          instrument: selected.instrument,
          timeframe: selected.timeframe,
          version: selected.version,
        }
      : null,
  );
  const regime = useQuantRegime(selected?.instrument ?? null, selected?.timeframe ?? 'H1');

  if (models.isError) return <ErrorState error={models.error} />;
  if (models.isLoading) return <LoadingRows rows={5} />;
  if (list.length === 0) {
    return (
      <EmptyState
        title="No models in the registry"
        description="Train + promote a champion (QN-043/046) — the quant dashboard reads calibration and regime for registry entries."
      />
    );
  }

  const curvePoints = normalizeCurve(calibration.data?.curve);
  const chartData = DIAGONAL.map((d) => ({ ...d }) as Record<string, number>);
  // Merge observed points into the chart series (recharts wants one array).
  const merged = [...chartData, ...curvePoints.map((c) => ({ p: c.p, observed: c.observed }))].sort(
    (a, b) => (a.p as number) - (b.p as number),
  );

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Interpret with care</AlertTitle>
        <AlertDescription>
          Retrain on ≥18 months H1 before trusting these curves — the initial model is a plumbing
          smoke artifact (OOF AUC ≈ 0.51).
        </AlertDescription>
      </Alert>

      <div className="flex items-center gap-2">
        <label htmlFor="quant-model" className="text-xs text-muted-foreground">
          Model
        </label>
        <select
          id="quant-model"
          className="rounded-md border bg-card px-2 py-1.5 text-sm"
          value={
            selected ? `${selected.instrument}/${selected.timeframe}/v${selected.version}` : ''
          }
          onChange={(e) => setSelectedKey(e.target.value)}
        >
          {list.map((m) => {
            const key = `${m.instrument}/${m.timeframe}/v${m.version}`;
            return (
              <option key={key} value={key}>
                {key} ({m.role})
              </option>
            );
          })}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Reliability diagram</CardTitle>
          </CardHeader>
          <CardContent>
            {calibration.isError ? (
              <ErrorState error={calibration.error} />
            ) : (
              <>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={merged} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis
                        dataKey="p"
                        type="number"
                        domain={[0, 1]}
                        tick={{ fontSize: 11, fill: '#9aa4b2' }}
                      />
                      <YAxis domain={[0, 1]} tick={{ fontSize: 11, fill: '#9aa4b2' }} />
                      <Tooltip
                        contentStyle={{
                          background: '#1b2130',
                          border: '1px solid #2a3346',
                          fontSize: 12,
                        }}
                      />
                      <ReferenceLine
                        segment={[
                          { x: 0, y: 0 },
                          { x: 1, y: 1 },
                        ]}
                        stroke="#4aa3ff"
                        strokeDasharray="4 4"
                      />
                      <Line
                        type="monotone"
                        dataKey="observed"
                        stroke="#22c55e"
                        dot={{ r: 3 }}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Blue dashed = perfect calibration; green = observed bins
                  {calibration.data && <> · method {calibration.data.calibration_method}</>}
                  {calibration.isLoading && <> · loading…</>}
                  {curvePoints.length === 0 && !calibration.isLoading && (
                    <> · no curve in this artifact yet</>
                  )}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Champion / challenger</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {list.slice(0, 6).map((m) => (
              <div
                key={`${m.instrument}/${m.timeframe}/v${m.version}`}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <p className="text-xs uppercase text-muted-foreground">{m.role}</p>
                  <p className="font-mono text-sm">
                    {m.instrument} / {m.timeframe} v{m.version}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    trained {new Date(m.trainedAt).toLocaleDateString()} · {m.calibrationMethod}
                  </p>
                </div>
                <Badge variant={m.role === 'champion' ? 'default' : 'secondary'}>{m.role}</Badge>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              A decalibrated champion shows a retrain banner once the drift feed (QN-046) is
              surfaced.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Regime timeline{' '}
            {regime.data && (
              <span className="font-normal text-muted-foreground">
                — current {regime.data.current}
                {regime.data.entropy !== null && <> · entropy {regime.data.entropy.toFixed(3)}</>}
                {' · '}debate rounds {regime.data.debate_rounds}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {regime.isError ? (
            <ErrorState error={regime.error} />
          ) : regime.isLoading ? (
            <LoadingRows rows={1} />
          ) : regime.data && regime.data.timeline.length > 0 ? (
            <div className="flex h-10 items-stretch overflow-hidden rounded-md">
              {regime.data.timeline.map((point) => (
                <div
                  key={point.ts}
                  title={`${point.ts} — ${point.regime}`}
                  className={`min-w-[2px] flex-1 ${REGIME_COLOR[point.regime] ?? 'bg-muted/40'}`}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No regime data"
              description="Needs cached candles (≥ minimum bars)."
            />
          )}
          <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-profit" /> trend up
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-loss" /> trend down
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-warning" /> range
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
