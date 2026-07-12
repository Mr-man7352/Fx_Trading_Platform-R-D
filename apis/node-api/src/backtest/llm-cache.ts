import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvokeParams, InvokeResult } from '@fx/llm';
import type { AgenticMode } from '@fx/types';
import type { LlmInvoker } from '../signals/agent-graph.js';

/**
 * QN-052 — the caching LLM invoker behind the three execution modes.
 *
 * Cache key (story AC): sha256 over (prompt hash — which already folds in the
 * prompt template version AND the agent-contract version — + role + the FULL
 * input bundle + `retrievedMemoryIds`). Memory injects per-bar context, so a
 * raw prompt-text hash without the bundle+memory-ids would yield near-zero
 * hits and must never be relied on for cost control.
 *
 * Modes:
 *   quant-only — the graph is never invoked; this class is not constructed.
 *   cached-llm — hits replay from disk at ZERO cost; misses fall through to
 *                the live client (filling the cache). A run is REPRODUCIBLE
 *                iff misses === 0 (the runner marks the result accordingly).
 *   live-llm   — always calls the live client (still writing the cache so a
 *                later cached run can replay it); explicitly NON-reproducible.
 *
 * Storage: one JSON file per key under `cacheDir` — deterministic, diffable,
 * survives across runs, needs no migration.
 */

export interface LlmCacheStats {
  calls: number;
  hits: number;
  misses: number;
  liveCostUsd: number;
}

interface CachedEntry {
  text: string;
  provider: InvokeResult['provider'];
  model: string;
  tier: InvokeResult['tier'];
  /** Original live cost — reported once at fill time, zero on replay. */
  originalCostUsd: number;
  cachedAt: string;
}

export function cacheKey(params: InvokeParams): string {
  const material = JSON.stringify({
    role: params.role,
    promptHash: params.promptHash,
    user: params.user,
    retrievedMemoryIds: params.retrievedMemoryIds ?? [],
  });
  return createHash('sha256').update(material).digest('hex');
}

export class CachingLlmInvoker implements LlmInvoker {
  readonly stats: LlmCacheStats = { calls: 0, hits: 0, misses: 0, liveCostUsd: 0 };

  constructor(
    private readonly mode: Exclude<AgenticMode, 'quant-only'>,
    private readonly cacheDir: string,
    /** Live client — required in live-llm mode and for cached-llm misses. */
    private readonly live: LlmInvoker | null,
  ) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.cacheDir, `${key}.json`);
  }

  async invoke(params: InvokeParams): Promise<InvokeResult> {
    this.stats.calls += 1;
    const key = cacheKey(params);
    const file = this.path(key);

    if (this.mode === 'cached-llm' && existsSync(file)) {
      this.stats.hits += 1;
      const entry = JSON.parse(readFileSync(file, 'utf8')) as CachedEntry;
      return {
        text: entry.text,
        provider: entry.provider,
        model: entry.model,
        tier: entry.tier,
        modelDowngraded: false,
        downgradeReason: null,
        failedOver: false,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0, // replay is free — LLM-cost accounting stays honest
      };
    }

    this.stats.misses += 1;
    if (!this.live) {
      throw new Error(
        `LLM cache miss in ${this.mode} mode with no live client configured (key ${key.slice(0, 12)}…)`,
      );
    }
    const result = await this.live.invoke(params);
    this.stats.liveCostUsd += result.costUsd;
    const entry: CachedEntry = {
      text: result.text,
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      originalCostUsd: result.costUsd,
      cachedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(entry, null, 2));
    return result;
  }

  /** QN-052 AC: cached mode with zero misses ⇒ reproducible. */
  get reproducible(): boolean {
    return this.mode === 'cached-llm' && this.stats.misses === 0;
  }
}
