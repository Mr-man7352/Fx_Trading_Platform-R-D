import type { AccountState } from '@fx/types';
import type { PrismaClient } from '../db.js';

/**
 * BE-066 — account state for the risk-team bundle (§9.6).
 *
 * Seam + DB implementation. Until live broker equity sync exists (the
 * reconciler tracks positions, not account summaries), equity is
 * `ACCOUNT_BASELINE_EQUITY` + realized P&L from the trades table — exact in
 * paper mode where every fill flows through BE-050. `dailyPnlPct` covers
 * REALIZED P&L today (UTC); unrealized P&L needs a price feed join and is
 * deliberately out of scope here (risk gate BE-070 gets its own inputs).
 * `openRiskPct` = aggregate stop-distance risk across open positions.
 */

export interface AccountStateProvider {
  current(): Promise<AccountState>;
}

export class DbAccountStateProvider implements AccountStateProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly baselineEquity: number,
  ) {}

  async current(): Promise<AccountState> {
    const [closed, todayClosed, open] = await Promise.all([
      this.prisma.trade.aggregate({
        _sum: { realizedPnl: true, swapPnl: true, commission: true },
        where: { status: 'closed' },
      }),
      this.prisma.trade.aggregate({
        _sum: { realizedPnl: true },
        where: { status: 'closed', closedAt: { gte: startOfUtcDay() } },
      }),
      this.prisma.trade.findMany({
        where: { status: 'open' },
        select: { entryPrice: true, stopLoss: true, units: true },
      }),
    ]);

    const equity =
      this.baselineEquity +
      num(closed._sum.realizedPnl) +
      num(closed._sum.swapPnl) -
      num(closed._sum.commission);

    const openRisk = open.reduce((sum, t) => {
      if (t.stopLoss === null) return sum;
      return sum + Math.abs(num(t.entryPrice) - num(t.stopLoss)) * num(t.units);
    }, 0);

    return {
      equity,
      openPositions: open.length,
      dailyPnlPct: equity > 0 ? num(todayClosed._sum.realizedPnl) / equity : 0,
      openRiskPct: equity > 0 ? openRisk / equity : 0,
    };
  }
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
