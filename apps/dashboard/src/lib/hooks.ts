'use client';

import type {
  AuditLogQuery,
  BacktestConfig,
  KillSwitchRequest,
  MarketCandlesQuery,
  SignalsQuery,
} from '@fx/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * FE-040…102 — react-query hooks over the typed `@fx/api-client`. Every read
 * is Zod-validated in the client; here we just own cache keys, polling, and
 * invalidation. Live surfaces additionally subscribe via `useWs` and call
 * `invalidateQueries` on the relevant frames.
 */

// ── Kill-switch (FE-040 / FE-042) ────────────────────────────────────────────
export function useKillSwitch() {
  return useQuery({
    queryKey: ['kill-switch'],
    queryFn: () => api.killSwitch.get(),
    refetchInterval: 15_000,
  });
}

export function useKillSwitchMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: KillSwitchRequest) => api.killSwitch.set(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kill-switch'] }),
  });
}

// ── Signals / agent debate (FE-060) ──────────────────────────────────────────
export function useSignals(query: Partial<SignalsQuery> = {}) {
  return useQuery({
    queryKey: ['signals', query],
    queryFn: () => api.signals.list(query),
  });
}

// ── Market data (FE-050) ─────────────────────────────────────────────────────
export function useInstruments() {
  return useQuery({
    queryKey: ['instruments'],
    queryFn: () => api.market.instruments(),
    staleTime: 60 * 60_000,
  });
}

export function useCandles(
  query: Partial<MarketCandlesQuery> & Pick<MarketCandlesQuery, 'instrument'>,
  enabled = true,
) {
  return useQuery({
    queryKey: ['candles', query],
    queryFn: () => api.market.candles(query),
    enabled,
  });
}

// ── Backtests (FE-080) ───────────────────────────────────────────────────────
export function useBacktests(query: { status?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ['backtests', query],
    queryFn: () => api.backtests.list(query),
  });
}

export function useBacktest(id: string | null) {
  return useQuery({
    queryKey: ['backtest', id],
    queryFn: () => api.backtests.get(id as string),
    enabled: !!id,
  });
}

export function useCreateBacktest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: BacktestConfig) => api.backtests.create(config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backtests'] }),
  });
}

// ── Audit (FE-102) ───────────────────────────────────────────────────────────
export function useAudit(query: Partial<AuditLogQuery> = {}) {
  return useQuery({
    queryKey: ['audit', query],
    queryFn: () => api.audit.list(query),
    placeholderData: (prev) => prev,
  });
}

// ── Trades (FE-070 — BE-054 seam) ────────────────────────────────────────────
export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: () => api.trades.list(),
  });
}
