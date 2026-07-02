import { describe, expect, it } from 'vitest';
import {
  contractSchemas,
  HealthResponseSchema,
  InstrumentSchema,
  TradingModeSchema,
} from './index.js';

describe('@fx/types contracts', () => {
  it('accepts the three trading modes and nothing else', () => {
    expect(TradingModeSchema.parse('paper')).toBe('paper');
    expect(() => TradingModeSchema.parse('demo')).toThrow();
  });

  it('validates OANDA-style instruments', () => {
    expect(InstrumentSchema.parse('EUR_USD')).toBe('EUR_USD');
    expect(InstrumentSchema.parse('XAU_USD')).toBe('XAU_USD');
    expect(() => InstrumentSchema.parse('EURUSD')).toThrow();
  });

  it('validates the /healthz contract', () => {
    const ok = { status: 'ok', commit: 'abc123', uptime: 12.5, tradingMode: 'paper' };
    expect(HealthResponseSchema.parse(ok)).toEqual(ok);
  });

  it('registers every contract for JSON Schema emit', () => {
    expect(Object.keys(contractSchemas).length).toBeGreaterThanOrEqual(8);
  });
});
