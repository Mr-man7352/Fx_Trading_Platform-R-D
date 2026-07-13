import type {
  AuditLogQuery,
  BacktestConfig,
  KillSwitchRequest,
  MarketCandlesQuery,
  NewsQuery,
  SignalsQuery,
} from '@fx/types';
import {
  ApiErrorSchema,
  AuditLogPageSchema,
  BacktestCreateResponseSchema,
  BacktestListResponseSchema,
  BacktestRunSchema,
  HealthResponseSchema,
  KillSwitchResponseSchema,
  MarketCandlesResponseSchema,
  MarketInstrumentsResponseSchema,
  NewsPageSchema,
  SignalsResponseSchema,
  STEP_UP_2FA_REQUIRED,
  TradesListResponseSchema,
} from '@fx/types';
import type { z } from 'zod';

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token supplier. Phase 1: internal service token (BE-013). Phase 5: NextAuth JWT. */
  getToken?: () => string | Promise<string | undefined> | undefined;
  /** Called on 401 — the app redirects to /sign-in (FE-005). */
  onUnauthorized?: () => void;
  /** Called on 403 STEP_UP_2FA_REQUIRED — the app opens the step-up modal (FE-005). */
  onStepUpRequired?: () => void;
  fetchImpl?: typeof fetch;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function parseError(res: Response): Promise<ApiClientError> {
  const fallback = new ApiClientError(res.status, 'UNKNOWN', `HTTP ${res.status}`);
  try {
    const body = ApiErrorSchema.parse(await res.json());
    return new ApiClientError(
      res.status,
      body.error.code,
      body.error.message,
      body.error.requestId,
    );
  } catch {
    return fallback;
  }
}

/** Drop undefined/empty values and serialise the rest into a `?a=b` string. */
function queryString(params: Record<string, unknown> = {}): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<S extends z.ZodType>(
    schema: S,
    path: string,
    init: RequestInit = {},
  ): Promise<z.output<S>> {
    const token = await options.getToken?.();
    const res = await fetchImpl(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (!res.ok) {
      const error = await parseError(res);
      if (res.status === 401) options.onUnauthorized?.();
      if (res.status === 403 && error.code === STEP_UP_2FA_REQUIRED) {
        options.onStepUpRequired?.();
      }
      throw error;
    }

    // Runtime Zod validation — a contract drift fails loudly, never silently (FE-005).
    return schema.parse(await res.json());
  }

  return {
    request,
    health: {
      get: () => request(HealthResponseSchema, '/healthz'),
    },
    // BE-054 seam — trades REST lands with the execution surface; typed since day one.
    trades: {
      list: () => request(TradesListResponseSchema, '/api/trades'),
    },
    // BE-045/BE-042 — market data (FE-050 charts). Server fills zod defaults, so
    // callers pass a partial query (only `instrument` is required for candles).
    market: {
      instruments: () => request(MarketInstrumentsResponseSchema, '/market/instruments'),
      candles: (q: Partial<MarketCandlesQuery> & Pick<MarketCandlesQuery, 'instrument'>) =>
        request(MarketCandlesResponseSchema, `/market/candles${queryString(q)}`),
      news: (q: Partial<NewsQuery> = {}) =>
        request(NewsPageSchema, `/market/news${queryString(q)}`),
    },
    // BE-067 — signals + agent-cycle summaries (FE-060 debate viewer).
    signals: {
      list: (q: Partial<SignalsQuery> = {}) =>
        request(SignalsResponseSchema, `/signals${queryString(q)}`),
    },
    // BE-090 — backtest trigger + results (FE-080).
    backtests: {
      list: (q: { status?: string; limit?: number } = {}) =>
        request(BacktestListResponseSchema, `/backtests${queryString(q)}`),
      get: (id: string) => request(BacktestRunSchema, `/backtests/${id}`),
      create: (config: BacktestConfig) =>
        request(BacktestCreateResponseSchema, '/backtests', {
          method: 'POST',
          body: JSON.stringify(config),
        }),
    },
    // BE-130 — append-only audit log (FE-102).
    audit: {
      list: (q: Partial<AuditLogQuery> = {}) =>
        request(AuditLogPageSchema, `/audit${queryString(q)}`),
    },
    // BE-072/073 — kill-switch (FE-040 home + FE-042 health strip).
    killSwitch: {
      get: () => request(KillSwitchResponseSchema, '/settings/kill-switch'),
      set: (body: KillSwitchRequest) =>
        request(KillSwitchResponseSchema, '/settings/kill-switch', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
