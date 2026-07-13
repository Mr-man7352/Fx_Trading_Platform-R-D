'use client';

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

/**
 * FE-090 — quant analytics: calibration reliability diagram, regime timeline,
 * and champion/challenger status. The QN-055 reads
 * (`/models/{…}/calibration`, `/regime/{instrument}`) live on the Python quant
 * service; the Node proxy that surfaces them to the browser is the remaining
 * seam. The reliability diagram renders its scaffold (perfect-calibration
 * diagonal) so the shape is clear; observed bins overlay once the proxy + a
 * retrained champion exist (the only trained model today has no edge).
 */

// Perfect-calibration reference diagonal.
const DIAGONAL = Array.from({ length: 11 }, (_, i) => ({ p: i / 10, ideal: i / 10 }));

export function QuantView() {
  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Calibration data pending</AlertTitle>
        <AlertDescription>
          Consumes the QN-055 <code>/calibration</code> and <code>/regime</code> reads via a Node
          proxy (seam) and a promoted champion. Retrain on ≥18 months H1 before trusting these
          curves — the current model is a plumbing smoke artifact (OOF AUC ≈ 0.51).
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Reliability diagram</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={DIAGONAL} margin={{ top: 8, right: 8, bottom: 8, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="p"
                    type="number"
                    domain={[0, 1]}
                    tick={{ fontSize: 11, fill: '#9aa4b2' }}
                    label={{
                      value: 'predicted',
                      position: 'insideBottom',
                      fontSize: 10,
                      fill: '#9aa4b2',
                    }}
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
                    dataKey="ideal"
                    stroke="transparent"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Blue dashed = perfect calibration. Observed bins overlay once the proxy is wired.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Champion / challenger</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Champion</p>
                <p className="font-mono text-sm">XAU_USD / H1 v1</p>
              </div>
              <Badge variant="destructive">no edge — retrain</Badge>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Drift monitor</p>
                <p className="font-mono text-sm">awaiting feed</p>
              </div>
              <Badge variant="secondary">QN-046</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              A decalibrated model shows a retrain banner here once the drift feed (QN-046) is
              surfaced.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Regime timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-10 items-center gap-1 overflow-hidden rounded-md">
            <div className="flex h-full flex-1 items-center justify-center bg-muted/40 text-xs text-muted-foreground">
              regime segments (TREND_UP / TREND_DOWN / RANGE) render from the QN-055 read
            </div>
          </div>
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
