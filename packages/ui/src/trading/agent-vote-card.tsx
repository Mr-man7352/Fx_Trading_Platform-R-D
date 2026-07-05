import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/**
 * FE-011 — <AgentVoteCard>: one analyst/PM vote in the multi-agent debate
 * (Phase 3 renders a list of these per signal). Purely presentational — the
 * debate payload contract lands with BE-06x/@fx/types in Phase 3.
 */
export type AgentVote = 'buy' | 'sell' | 'hold' | 'veto';

export const AGENT_VOTE_STYLES: Record<AgentVote, string> = {
  buy: 'bg-profit/15 text-profit border-profit/50',
  sell: 'bg-loss/15 text-loss border-loss/50',
  hold: 'bg-muted text-muted-foreground border-border',
  veto: 'bg-destructive/15 text-destructive border-destructive/50',
};

export interface AgentVoteCardProps extends ComponentProps<'div'> {
  /** e.g. "Technical Analyst", "Risk PM" */
  agentName: string;
  vote: AgentVote;
  /** 0..1 — rendered as a percentage + meter. */
  confidence: number;
  /** Pinned model snapshot id (BE-061), e.g. "claude-sonnet-5@2026-06-01". */
  modelId: string;
  /** Optional one-line rationale summary. */
  summary?: string;
}

export function AgentVoteCard({
  agentName,
  vote,
  confidence,
  modelId,
  summary,
  className,
  ...props
}: AgentVoteCardProps) {
  const pct = Math.round(Math.min(Math.max(confidence, 0), 1) * 100);
  return (
    <div
      data-vote={vote}
      className={cn('rounded-lg border bg-card p-4 shadow-sm', className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{agentName}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{modelId}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-md border px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider',
            AGENT_VOTE_STYLES[vote],
          )}
        >
          {vote}
        </span>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Confidence</span>
          <span className="font-mono tabular-nums">{pct}%</span>
        </div>
        <div
          role="meter"
          aria-label={`${agentName} confidence`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {summary && <p className="mt-3 text-sm text-muted-foreground">{summary}</p>}
    </div>
  );
}
