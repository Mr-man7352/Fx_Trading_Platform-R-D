import type { ProviderName } from './catalog.js';

/**
 * BE-060 — provider failure classification drives the failover policy:
 * `timeout`/`server` → immediate single fallback; `rate_limit` → capped
 * backoff then fallback; `fatal` (bad key, 4xx) → fallback too (a
 * misconfigured primary must not block trading).
 */
export type LlmErrorKind = 'timeout' | 'rate_limit' | 'server' | 'fatal';

export class LlmProviderError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: ProviderName;
  readonly status: number | null;

  constructor(provider: ProviderName, kind: LlmErrorKind, message: string, status?: number) {
    super(`[${provider}] ${message}`);
    this.name = 'LlmProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = status ?? null;
  }
}

/** Primary + the single fallback both failed — callers map to HOLD (`PROVIDER_EXHAUSTED`). */
export class LlmExhaustedError extends Error {
  readonly attempts: LlmProviderError[];

  constructor(attempts: LlmProviderError[]) {
    super(
      `LLM provider chain exhausted after ${attempts.length} attempt(s): ${attempts
        .map((a) => `${a.provider}=${a.kind}`)
        .join(', ')}`,
    );
    this.name = 'LlmExhaustedError';
    this.attempts = attempts;
  }
}
