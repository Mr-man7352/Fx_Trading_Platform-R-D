import { createEmailSender, type EmailSender } from '../auth/email.js';
import type { PrismaClient } from '../db.js';
import type { Env } from '../env.js';

/**
 * BE-116 — Resend email digests. Repeatable BullMQ crons (registered in
 * execution-main.ts, which already hosts the notifications family):
 *   - daily  @ 22:00 UTC  (AC) — `digest-daily`
 *   - weekly @ Sun 22:00 UTC   — `digest-weekly`
 *
 * Mock-first: without DIGEST_EMAIL_TO the digest is composed and logged only;
 * with it (+ RESEND_API_KEY) it goes out via the same EmailSender as BE-034.
 * Numbers are computed from the DB (closed trades, signal cycles, LLM spend)
 * — never fabricated; empty windows send an honest "no activity" digest.
 */

export const DIGESTS_QUEUE = 'digests';

export interface DigestJob {
  kind: 'daily' | 'weekly';
}

export interface DigestStats {
  from: Date;
  to: Date;
  closedTrades: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  signalsCreated: number;
  signalsExecuted: number;
  llmCostUsd: number;
  killSwitchActivations: number;
}

export async function gatherDigestStats(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<DigestStats> {
  const [closed, signals, executed, llm, killSwitch] = await Promise.all([
    prisma.trade.findMany({
      where: { status: 'closed', closedAt: { gte: from, lt: to } },
      select: { realizedPnl: true },
    }),
    prisma.signal.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.signal.count({ where: { createdAt: { gte: from, lt: to }, status: 'executed' } }),
    prisma.agentRun.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: from, lt: to } },
    }),
    prisma.killSwitchState.count({ where: { activatedAt: { gte: from, lt: to } } }),
  ]);
  const pnls = closed.map((t) => Number(t.realizedPnl ?? 0));
  return {
    from,
    to,
    closedTrades: closed.length,
    realizedPnl: pnls.reduce((a, b) => a + b, 0),
    wins: pnls.filter((p) => p > 0).length,
    losses: pnls.filter((p) => p < 0).length,
    signalsCreated: signals,
    signalsExecuted: executed,
    llmCostUsd: Number(llm._sum.costUsd ?? 0),
    killSwitchActivations: killSwitch,
  };
}

export function composeDigest(
  kind: 'daily' | 'weekly',
  mode: string,
  s: DigestStats,
): {
  subject: string;
  text: string;
} {
  const window = `${s.from.toISOString().slice(0, 10)} → ${s.to.toISOString().slice(0, 10)}`;
  const pnl = s.realizedPnl.toFixed(2);
  const subject = `FX ${kind} digest (${mode}) — ${s.closedTrades} closed, P&L ${pnl}`;
  const lines = [
    `FX Platform ${kind} digest (${mode} mode) — ${window}`,
    '',
    `Closed trades: ${s.closedTrades} (${s.wins} wins / ${s.losses} losses)`,
    `Realized P&L: ${pnl}`,
    `Signal cycles: ${s.signalsCreated} created, ${s.signalsExecuted} executed`,
    `LLM spend: $${s.llmCostUsd.toFixed(4)}`,
    `Kill-switch activations: ${s.killSwitchActivations}`,
    '',
    s.closedTrades === 0 && s.signalsCreated === 0
      ? 'No trading activity in this window.'
      : 'Full provenance on the dashboard: /trades and /agents.',
  ];
  return { subject, text: lines.join('\n') };
}

export interface DigestDeps {
  prisma: PrismaClient;
  env: Env;
  sender?: EmailSender;
  now?: () => Date;
}

export async function processDigestJob(job: { data: DigestJob }, deps: DigestDeps): Promise<void> {
  const { kind } = job.data;
  const now = deps.now ? deps.now() : new Date();
  const windowMs = kind === 'weekly' ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
  const from = new Date(now.getTime() - windowMs);

  const stats = await gatherDigestStats(deps.prisma, from, now);
  const { subject, text } = composeDigest(kind, deps.env.TRADING_MODE, stats);

  const to = deps.env.DIGEST_EMAIL_TO;
  if (!to) {
    console.log(`[digest] DIGEST_EMAIL_TO unset — logging only\n${subject}\n${text}`);
    return;
  }
  const sender =
    deps.sender ??
    createEmailSender(
      {
        resendApiKey: deps.env.RESEND_API_KEY,
        from: deps.env.EMAIL_FROM,
        appBaseUrl: deps.env.APP_BASE_URL,
      },
      { info: (o, m) => console.log(m ?? '', o), error: (o, m) => console.error(m ?? '', o) },
    );
  await sender.send({ to, subject, text });
}

/** Cron specs (BullMQ repeatable): daily 22:00 UTC (AC) + weekly Sun 22:00 UTC. */
export const DIGEST_CRONS = [
  { kind: 'daily' as const, pattern: '0 22 * * *', jobId: 'digest-daily' },
  { kind: 'weekly' as const, pattern: '0 22 * * 0', jobId: 'digest-weekly' },
];
