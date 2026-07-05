import type { Instrument, InstrumentInfo } from '@fx/types';

/**
 * BE-045 — static instrument registry (there is no `instruments` DB table in
 * Step 1.4). ~8 instruments in scope: FX majors + XAU/USD + WTI/Brent
 * (System Design scope guardrails). Broker symbol mappings here seed QN-033's
 * fuller symbol-mapping table in Phase 2. `pipLocation` is the power-of-ten of
 * one pip (EUR_USD pip 0.0001 → -4; JPY/metals/energy → -2).
 */
export const INSTRUMENTS: readonly InstrumentInfo[] = [
  fx('EUR_USD', 'EUR/USD', 'USD', -4),
  fx('GBP_USD', 'GBP/USD', 'USD', -4),
  fx('USD_JPY', 'USD/JPY', 'JPY', -2),
  fx('USD_CHF', 'USD/CHF', 'CHF', -4),
  fx('AUD_USD', 'AUD/USD', 'USD', -4),
  fx('USD_CAD', 'USD/CAD', 'CAD', -4),
  fx('NZD_USD', 'NZD/USD', 'USD', -4),
  {
    name: 'XAU_USD',
    displayName: 'Gold',
    kind: 'metal',
    oandaSymbol: 'XAU_USD',
    twelveDataSymbol: 'XAU/USD',
    pipLocation: -2,
    quoteCurrency: 'USD',
    tradeable: true,
  },
  {
    name: 'WTICO_USD',
    displayName: 'WTI Crude Oil',
    kind: 'energy',
    oandaSymbol: 'WTICO_USD',
    // Twelve Data free tier does not reliably carry OANDA's CFD oil symbol;
    // cross-check is skipped for energy until a vendor mapping is confirmed.
    twelveDataSymbol: null,
    pipLocation: -2,
    quoteCurrency: 'USD',
    tradeable: true,
  },
  {
    name: 'BCO_USD',
    displayName: 'Brent Crude Oil',
    kind: 'energy',
    oandaSymbol: 'BCO_USD',
    twelveDataSymbol: null,
    pipLocation: -2,
    quoteCurrency: 'USD',
    tradeable: true,
  },
];

function fx(
  name: string,
  twelveDataSymbol: string,
  quoteCurrency: string,
  pipLocation: number,
): InstrumentInfo {
  return {
    name,
    displayName: name.replace('_', '/'),
    kind: 'fx_major',
    oandaSymbol: name,
    twelveDataSymbol,
    pipLocation,
    quoteCurrency,
    tradeable: true,
  };
}

const BY_NAME: ReadonlyMap<string, InstrumentInfo> = new Map(INSTRUMENTS.map((i) => [i.name, i]));

/** Lookup by canonical name; undefined for unknown/unsupported instruments. */
export function getInstrument(name: string): InstrumentInfo | undefined {
  return BY_NAME.get(name);
}

/** True when `name` is a configured, in-scope instrument. */
export function isKnownInstrument(name: string): name is Instrument {
  return BY_NAME.has(name);
}

/** One pip expressed as an absolute price increment, e.g. EUR_USD → 0.0001. */
export function pipSize(info: InstrumentInfo): number {
  return 10 ** info.pipLocation;
}
