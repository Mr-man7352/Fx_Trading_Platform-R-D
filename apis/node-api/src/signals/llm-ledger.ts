import type { LedgerSink, LlmRunRecord, SpendProvider } from '@fx/llm';
import type { PrismaClient } from '../db.js';

/**
 * BE-060 — Prisma implementations of @fx/llm's persistence seams.
 *
 * `agent_runs` IS the cost ledger: one row per successful LLM call with
 * provider/model/tier provenance (BE-061), token + USD accounting, and the
 * `model_downgraded` flag §9.4's paper-window policy filters on. Month-to-
 * date spend is an aggregate over `created_at` (indexed).
 */

export class PrismaLedgerSink implements LedgerSink {
  constructor(private readonly prisma: PrismaClient) {}

  async record(run: LlmRunRecord): Promise<void> {
    await this.prisma.agentRun.create({
      data: {
        signalId: run.signalId,
        agentRole: run.role,
        provider: run.provider,
        model: run.model,
        tier: run.tier,
        promptHash: run.promptHash,
        modelDowngraded: run.modelDowngraded,
        downgradeReason: run.downgradeReason,
        failedOver: run.failedOver,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
        latencyMs: run.latencyMs,
        retrievedMemoryIds: run.retrievedMemoryIds,
        output: run.outputText,
      },
    });
  }
}

export class PrismaSpendProvider implements SpendProvider {
  constructor(private readonly prisma: PrismaClient) {}

  /** Sum of this calendar month's (UTC) LLM spend — drives the 90%/95% caps. */
  async monthToDateUsd(): Promise<number> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const result = await this.prisma.agentRun.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: monthStart } },
    });
    return Number(result._sum.costUsd ?? 0);
  }
}
