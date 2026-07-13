import type { Candle } from '@fx/types';

/** Exponential moving average over candle closes, aligned to bar times (seconds). */
export function ema(candles: Candle[], period: number): { time: number; value: number }[] {
  const first = candles[0];
  if (!first) return [];
  const k = 2 / (period + 1);
  const out: { time: number; value: number }[] = [];
  let prev = first.close;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;
    prev = i === 0 ? candle.close : candle.close * k + prev * (1 - k);
    if (i >= period - 1) out.push({ time: toSec(candle.ts), value: prev });
  }
  return out;
}

export function toSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
