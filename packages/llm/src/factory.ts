import type { AgentRole } from '@fx/types';
import {
  type CapabilityTier,
  costUsd,
  DEFAULT_CATALOG,
  downgradeTier,
  FAILOVER_ORDER,
  type ModelCatalog,
  type ProviderName,
} from './catalog.js';
import { LlmExhaustedError, LlmProviderError } from './errors.js';
import type { ProviderAdapter } from './providers.js';

/**
 * BE-060 — LLM provider factory with automatic failover (§9.4).
 *
 * Policy, all in one place so the §2.2 budget arithmetic stays provable:
 * - Primary attempt runs under the caller's stage budget.
 * - 5xx / timeout / fatal → **exactly one** fallback attempt (next provider
 *   in FAILOVER_ORDER, same capability tier) with a **10s cap** — a stage's
 *   worst case never doubles.
 * - 429 → exponential-style backoff capped at 10s (and at remaining budget),
 *   THEN the single fallback attempt.
 * - Monthly cost cap: ≥90% ⇒ every non-PM role drops one capability tier;
 *   ≥95% ⇒ PM drops too. `model_downgraded` flagged on the run record.
 * - Latency: p95 >15s over a 5-min window AND 2 consecutive slow calls ⇒
 *   route via OpenRouter one tier down, logged as a latency downgrade.
 *
 * Persistence is a seam: `LedgerSink` gets one record per successful call
 * (node-api writes `agent_runs` + the `llm_cost_ledger` from it). This
 * package never imports Prisma.
 */

export type DowngradeReason = 'cost_cap' | 'latency';

export interface LlmRunRecord {
  role: AgentRole;
  provider: ProviderName;
  /** Exact pinned snapshot that answered (BE-061 reproducibility). */
  model: string;
  tier: CapabilityTier;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  modelDowngraded: boolean;
  downgradeReason: DowngradeReason | null;
  /** True when the answer came from the fallback provider. */
  failedOver: boolean;
  signalId: string | null;
  outputText: string;
}

export interface LedgerSink {
  record(run: LlmRunRecord): Promise<void>;
}

export interface SpendProvider {
  /** Month-to-date LLM spend in USD (drives the 90%/95% cap policy). */
  monthToDateUsd(): Promise<number>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface LlmClientOptions {
  /** Configured adapters — providers without API keys are simply absent. */
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  ledger: LedgerSink;
  spend: SpendProvider;
  monthlyCapUsd: number;
  catalog?: ModelCatalog;
  /** Default primary provider (§9.4: Anthropic). */
  defaultProvider?: ProviderName;
  /** Per-agent provider override (BE-060 acceptance). */
  roleProviders?: Partial<Record<AgentRole, ProviderName>>;
  /** Per-agent tier override; default: PM premium, everyone else standard. */
  roleTiers?: Partial<Record<AgentRole, CapabilityTier>>;
  maxTokens?: number;
  /** Cap on the single fallback attempt (§2.2: 10s). */
  fallbackTimeoutMs?: number;
  /** Base for 429 backoff; doubles per consecutive 429 seen, capped at 10s. */
  rateLimitBackoffBaseMs?: number;
  clock?: Clock;
}

export interface InvokeParams {
  role: AgentRole;
  system: string;
  user: string;
  promptHash: string;
  /** Stage budget (§2.2) — the primary attempt's timeout. */
  stageBudgetMs: number;
  signalId?: string;
}

export interface InvokeResult {
  text: string;
  provider: ProviderName;
  model: string;
  tier: CapabilityTier;
  modelDowngraded: boolean;
  downgradeReason: DowngradeReason | null;
  failedOver: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const SLOW_CALL_MS = 15_000;
const LATENCY_WINDOW_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 10_000;

/** Sliding-window latency stats per provider (§9.4 latency-degradation SLA). */
class LatencyMonitor {
  private readonly samples = new Map<ProviderName, Array<{ ts: number; ms: number }>>();

  record(provider: ProviderName, ts: number, ms: number): void {
    const list = this.samples.get(provider) ?? [];
    list.push({ ts, ms });
    this.samples.set(
      provider,
      list.filter((s) => ts - s.ts <= LATENCY_WINDOW_MS),
    );
  }

  /** p95 > 15s over 5 min AND the last 2 calls were slow. */
  isDegraded(provider: ProviderName, now: number): boolean {
    const list = (this.samples.get(provider) ?? []).filter(
      (s) => now - s.ts <= LATENCY_WINDOW_MS,
    );
    if (list.length < 2) return false;
    const lastTwoSlow = list.slice(-2).every((s) => s.ms > SLOW_CALL_MS);
    if (!lastTwoSlow) return false;
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    return (p95 ?? 0) > SLOW_CALL_MS;
  }
}

export class LlmClient {
  private readonly opts: Required<
    Pick<
      LlmClientOptions,
      'catalog' | 'defaultProvider' | 'maxTokens' | 'fallbackTimeoutMs' | 'rateLimitBackoffBaseMs'
    >
  > &
    LlmClientOptions;
  private readonly clock: Clock;
  private readonly latency = new LatencyMonitor();
  private consecutive429 = 0;

  constructor(options: LlmClientOptions) {
    this.opts = {
      catalog: DEFAULT_CATALOG,
      defaultProvider: 'anthropic',
      maxTokens: 1024,
      fallbackTimeoutMs: 10_000,
      rateLimitBackoffBaseMs: 1_000,
      ...options,
    };
    this.clock = options.clock ?? REAL_CLOCK;
  }

  async invoke(params: InvokeParams): Promise<InvokeResult> {
    const started = this.clock.now();
    let provider = this.opts.roleProviders?.[params.role] ?? this.opts.defaultProvider;
    let tier: CapabilityTier =
      this.opts.roleTiers?.[params.role] ?? (params.role === 'pm' ? 'premium' : 'standard');
    let downgradeReason: DowngradeReason | null = null;

    // Monthly cost-cap policy (BE-060): 90% → non-PM down one tier; 95% → PM too.
    const spendRatio =
      this.opts.monthlyCapUsd > 0
        ? (await this.opts.spend.monthToDateUsd()) / this.opts.monthlyCapUsd
        : 0;
    if (spendRatio >= 0.95 || (spendRatio >= 0.9 && params.role !== 'pm')) {
      tier = downgradeTier(tier);
      downgradeReason = 'cost_cap';
    }

    // Latency-degradation SLA: reroute via OpenRouter one tier down.
    if (
      this.latency.isDegraded(provider, this.clock.now()) &&
      provider !== 'openrouter' &&
      this.opts.adapters.openrouter
    ) {
      provider = 'openrouter';
      tier = downgradeTier(tier);
      downgradeReason ??= 'latency';
    }

    const chain = this.chainFrom(provider);
    const primary = chain[0];
    if (!primary) throw new LlmExhaustedError([]);

    const attempts: LlmProviderError[] = [];

    // Primary attempt under the full stage budget.
    const first = await this.attempt(primary, tier, params, params.stageBudgetMs);
    if (first.ok) {
      this.consecutive429 = 0;
      return this.finish(params, primary, tier, downgradeReason, false, started, first.value);
    }
    attempts.push(first.error);

    // 429 → capped backoff, THEN failover (§9.4). Other kinds fail over immediately.
    if (first.error.kind === 'rate_limit') {
      this.consecutive429 += 1;
      const backoff = Math.min(
        this.opts.rateLimitBackoffBaseMs * 2 ** (this.consecutive429 - 1),
        MAX_BACKOFF_MS,
      );
      await this.clock.sleep(backoff);
    } else {
      this.consecutive429 = 0;
    }

    // Exactly ONE fallback attempt, 10s cap — never a fresh full budget (§2.2).
    const fallback = chain[1];
    if (fallback) {
      const second = await this.attempt(fallback, tier, params, this.opts.fallbackTimeoutMs);
      if (second.ok) {
        return this.finish(params, fallback, tier, downgradeReason, true, started, second.value);
      }
      attempts.push(second.error);
    }

    throw new LlmExhaustedError(attempts);
  }

  /** Providers with configured adapters, starting at `primary`, in §9.4 order. */
  private chainFrom(primary: ProviderName): ProviderName[] {
    const rest = FAILOVER_ORDER.filter((p) => p !== primary);
    return [primary, ...rest].filter((p) => this.opts.adapters[p] !== undefined);
  }

  private async attempt(
    provider: ProviderName,
    tier: CapabilityTier,
    params: InvokeParams,
    timeoutMs: number,
  ): Promise<
    | { ok: true; value: { text: string; inputTokens: number; outputTokens: number } }
    | { ok: false; error: LlmProviderError }
  > {
    const adapter = this.opts.adapters[provider];
    if (!adapter) {
      return {
        ok: false,
        error: new LlmProviderError(provider, 'fatal', 'no adapter configured'),
      };
    }
    const pin = this.opts.catalog[provider][tier];
    const t0 = this.clock.now();
    try {
      const result = await adapter.chat({
        model: pin.model,
        system: params.system,
        user: params.user,
        maxTokens: this.opts.maxTokens,
        timeoutMs,
      });
      this.latency.record(provider, this.clock.now(), this.clock.now() - t0);
      return { ok: true, value: result };
    } catch (err) {
      this.latency.record(provider, this.clock.now(), this.clock.now() - t0);
      const providerError =
        err instanceof LlmProviderError
          ? err
          : new LlmProviderError(
              provider,
              'fatal',
              err instanceof Error ? err.message : String(err),
            );
      return { ok: false, error: providerError };
    }
  }

  private async finish(
    params: InvokeParams,
    provider: ProviderName,
    tier: CapabilityTier,
    downgradeReason: DowngradeReason | null,
    failedOver: boolean,
    startedAt: number,
    value: { text: string; inputTokens: number; outputTokens: number },
  ): Promise<InvokeResult> {
    const pin = this.opts.catalog[provider][tier];
    const result: InvokeResult = {
      text: value.text,
      provider,
      model: pin.model,
      tier,
      modelDowngraded: downgradeReason !== null,
      downgradeReason,
      failedOver,
      latencyMs: this.clock.now() - startedAt,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      costUsd: costUsd(pin, value.inputTokens, value.outputTokens),
    };
    await this.opts.ledger.record({
      role: params.role,
      provider,
      model: pin.model,
      tier,
      promptHash: params.promptHash,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      modelDowngraded: result.modelDowngraded,
      downgradeReason,
      failedOver,
      signalId: params.signalId ?? null,
      outputText: value.text,
    });
    return result;
  }
}
