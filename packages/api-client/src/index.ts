import {
  ApiErrorSchema,
  HealthResponseSchema,
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
    trades: {
      list: () => request(TradesListResponseSchema, '/api/trades'),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
