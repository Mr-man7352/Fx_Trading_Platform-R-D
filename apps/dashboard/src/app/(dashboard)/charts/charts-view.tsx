'use client';

import type { Timeframe } from '@fx/types';
import { Button, Card, CardContent } from '@fx/ui';
import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState, LoadingRows } from '@/components/states';
import { useCandles, useInstruments, useSignals } from '@/lib/hooks';
import { ema, toSec } from './lib';

const TIMEFRAMES: Timeframe[] = ['H1', 'D1'];

/**
 * FE-050 — Lightweight Charts candles with EMA(20/50) overlays and past-signal
 * markers (entry side + probability). Candles come from `/market/candles`
 * (BE-045); markers from `/signals` (BE-067) filtered to the instrument. Regime
 * background shading (QN-041) is a seam — regime-per-bar is not on the candle
 * feed yet — noted in the caption rather than faked.
 */
export function ChartsView() {
  const instruments = useInstruments();
  const [instrument, setInstrument] = useState('EUR_USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('H1');

  const candles = useCandles({ instrument, timeframe, limit: 500 });
  const signals = useSignals({ instrument, limit: 100 });

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9aa4b2',
        fontFamily: 'ui-monospace, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      timeScale: { timeVisible: true, borderColor: 'rgba(255,255,255,0.1)' },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a17b',
      downColor: '#e5484d',
      borderVisible: false,
      wickUpColor: '#26a17b',
      wickDownColor: '#e5484d',
    });
    ema20Ref.current = chart.addSeries(LineSeries, { color: '#4aa3ff', lineWidth: 1 });
    ema50Ref.current = chart.addSeries(LineSeries, { color: '#f5a623', lineWidth: 1 });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  const rows = candles.data?.candles ?? [];

  // Push data + markers on change.
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;
    const data: CandlestickData[] = rows.map((c) => ({
      time: toSec(c.ts) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    cs.setData(data);
    ema20Ref.current?.setData(ema(rows, 20).map((p) => ({ ...p, time: p.time as UTCTimestamp })));
    ema50Ref.current?.setData(ema(rows, 50).map((p) => ({ ...p, time: p.time as UTCTimestamp })));

    const markers: SeriesMarker<UTCTimestamp>[] = (signals.data?.signals ?? [])
      .filter((s) => s.instrument === instrument)
      .map((s) => ({
        time: toSec(s.barTs) as UTCTimestamp,
        position: s.side === 'long' ? 'belowBar' : 'aboveBar',
        color: s.side === 'long' ? '#26a17b' : '#e5484d',
        shape: s.side === 'long' ? 'arrowUp' : 'arrowDown',
        text: s.probability !== null ? `P${(s.probability * 100).toFixed(0)}` : s.status,
      }));
    createSeriesMarkers(cs, markers);
    chartRef.current?.timeScale().fitContent();
  }, [rows, signals.data, instrument]);

  const instrumentList = useMemo(
    () =>
      instruments.data?.instruments.map((i) => ({ name: i.name, displayName: i.displayName })) ?? [
        { name: 'EUR_USD', displayName: 'EUR/USD' },
      ],
    [instruments.data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
          className="rounded-md border bg-card px-3 py-1.5 font-mono text-sm"
          aria-label="Instrument"
        >
          {instrumentList.map((i) => (
            <option key={i.name} value={i.name}>
              {i.displayName}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <Button
              key={tf}
              size="sm"
              variant={timeframe === tf ? 'default' : 'outline'}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </Button>
          ))}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{rows.length} bars</span>
      </div>

      {candles.isError ? (
        <ErrorState error={candles.error} />
      ) : candles.isLoading ? (
        <LoadingRows rows={6} />
      ) : (
        <Card>
          <CardContent className="p-2">
            <div ref={containerRef} className="h-[520px] w-full" />
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        EMA(20) blue · EMA(50) amber · markers are past quant candidates with entry side and
        probability. Per-bar regime shading (QN-041) and SL/TP overlays arrive with the regime feed.
      </p>
    </div>
  );
}
