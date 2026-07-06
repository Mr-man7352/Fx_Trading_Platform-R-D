/** BE-053 — OANDA REST flatten only. NEVER opens positions. */

const ORDER_CREATE_PATH = /\/orders$/;

export function assertNoOrderCreate(url: string, method: string): void {
  if (method === 'POST' && ORDER_CREATE_PATH.test(new URL(url).pathname)) {
    throw new Error('watchdog must never call order-create endpoints');
  }
}

export interface OpenPosition {
  instrument: string;
  longUnits: number;
  shortUnits: number;
}

export async function listOpenPositions(
  baseUrl: string,
  token: string,
  accountId: string,
): Promise<OpenPosition[]> {
  const url = `${baseUrl}/v3/accounts/${accountId}/openPositions`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`openPositions HTTP ${res.status}`);
  const data = (await res.json()) as {
    positions: {
      instrument: string;
      long?: { units: string };
      short?: { units: string };
    }[];
  };
  return (data.positions ?? []).map((p) => ({
    instrument: p.instrument,
    longUnits: Math.abs(Number(p.long?.units ?? 0)),
    shortUnits: Math.abs(Number(p.short?.units ?? 0)),
  }));
}

export async function closePositionSide(
  baseUrl: string,
  token: string,
  accountId: string,
  instrument: string,
  side: 'long' | 'short',
): Promise<void> {
  const url = `${baseUrl}/v3/accounts/${accountId}/positions/${instrument}/close`;
  assertNoOrderCreate(url, 'PUT');
  const body = side === 'long' ? { longUnits: 'ALL' } : { shortUnits: 'ALL' };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`close ${instrument}/${side} HTTP ${res.status}`);
}

export async function flattenAll(baseUrl: string, token: string, accountId: string): Promise<void> {
  const positions = await listOpenPositions(baseUrl, token, accountId);
  for (const p of positions) {
    if (p.longUnits > 0) await closePositionSide(baseUrl, token, accountId, p.instrument, 'long');
    if (p.shortUnits > 0) await closePositionSide(baseUrl, token, accountId, p.instrument, 'short');
  }
  const after = await listOpenPositions(baseUrl, token, accountId);
  const flat = after.every((p) => p.longUnits === 0 && p.shortUnits === 0);
  if (!flat) throw new Error('flatten incomplete');
}
