import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvokeParams, InvokeResult } from '@fx/llm';
import { afterEach, describe, expect, it } from 'vitest';
import { CachingLlmInvoker, cacheKey } from './llm-cache.js';

/** QN-052 — cache key + mode semantics. */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-cache-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function params(overrides: Partial<InvokeParams> = {}): InvokeParams {
  return {
    role: 'trader',
    system: 'sys',
    user: '{"bundle":1}',
    promptHash: 'hash-v1',
    stageBudgetMs: 1000,
    retrievedMemoryIds: ['a', 'b'],
    ...overrides,
  };
}

function liveStub(text = 'live-answer'): {
  invoke: (p: InvokeParams) => Promise<InvokeResult>;
  calls: number;
} {
  const stub = {
    calls: 0,
    async invoke(): Promise<InvokeResult> {
      stub.calls += 1;
      return {
        text,
        provider: 'anthropic',
        model: 'm1',
        tier: 'standard',
        modelDowngraded: false,
        downgradeReason: null,
        failedOver: false,
        latencyMs: 5,
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.01,
      };
    },
  };
  return stub;
}

describe('cacheKey (QN-052 AC)', () => {
  it('changes when retrievedMemoryIds change — memory injects per-bar context', () => {
    expect(cacheKey(params({ retrievedMemoryIds: ['a'] }))).not.toBe(
      cacheKey(params({ retrievedMemoryIds: ['a', 'b'] })),
    );
  });
  it('changes with prompt hash (template version) and bundle', () => {
    expect(cacheKey(params({ promptHash: 'hash-v2' }))).not.toBe(cacheKey(params()));
    expect(cacheKey(params({ user: '{"bundle":2}' }))).not.toBe(cacheKey(params()));
  });
  it('is stable for identical inputs', () => {
    expect(cacheKey(params())).toBe(cacheKey(params()));
  });
});

describe('CachingLlmInvoker', () => {
  it('cached-llm: miss fills the cache via live, hit replays at zero cost', async () => {
    const dir = tempDir();
    const live = liveStub();
    const invoker = new CachingLlmInvoker('cached-llm', dir, live);

    const first = await invoker.invoke(params());
    expect(first.costUsd).toBe(0.01);
    expect(invoker.stats).toMatchObject({ calls: 1, hits: 0, misses: 1 });
    expect(invoker.reproducible).toBe(false); // a miss occurred

    const second = await invoker.invoke(params());
    expect(second.text).toBe('live-answer');
    expect(second.costUsd).toBe(0); // replay is free
    expect(live.calls).toBe(1); // no second live call
    expect(invoker.stats.hits).toBe(1);
  });

  it('a fresh invoker over a warm cache is reproducible (all hits)', async () => {
    const dir = tempDir();
    await new CachingLlmInvoker('cached-llm', dir, liveStub()).invoke(params());
    const replay = new CachingLlmInvoker('cached-llm', dir, null);
    await replay.invoke(params());
    expect(replay.stats).toMatchObject({ calls: 1, hits: 1, misses: 0 });
    expect(replay.reproducible).toBe(true);
  });

  it('cached-llm miss with no live client fails loudly', async () => {
    const invoker = new CachingLlmInvoker('cached-llm', tempDir(), null);
    await expect(invoker.invoke(params())).rejects.toThrow(/cache miss/);
  });

  it('live-llm always calls live (never reproducible) but still fills the cache', async () => {
    const dir = tempDir();
    const live = liveStub();
    const invoker = new CachingLlmInvoker('live-llm', dir, live);
    await invoker.invoke(params());
    await invoker.invoke(params());
    expect(live.calls).toBe(2);
    expect(invoker.reproducible).toBe(false);
    // …but a cached-mode replay can now use what live wrote.
    const replay = new CachingLlmInvoker('cached-llm', dir, null);
    const res = await replay.invoke(params());
    expect(res.text).toBe('live-answer');
    expect(replay.reproducible).toBe(true);
  });
});
