import { describe, expect, it } from 'vitest';
import type { ProviderName } from './catalog.js';
import { LlmExhaustedError, LlmProviderError } from './errors.js';
import {
  type Clock,
  LlmClient,
  type LlmClientOptions,
  type LlmRunRecord,
} from './factory.js';
import type { ChatParams, ChatResult, ProviderAdapter } from './providers.js';

/** BE-060 — failover / downgrade / ledger policy tests (fake providers). */

class FakeClock implements Clock {
  t = 0;
  slept: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.t += ms;
  }
}

type Behaviour =
  | { kind: 'ok'; latencyMs?: number }
  | { kind: 'fail'; error: 'timeout' | 'rate_limit' | 'server' | 'fatal' };

class FakeAdapter implements ProviderAdapter {
  calls: ChatParams[] = [];
  constructor(
    readonly name: ProviderName,
    private readonly clock: FakeClock,
    private behaviours: Behaviour[],
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const behaviour = this.behaviours.length > 1 ? this.behaviours.shift() : this.behaviours[0];
    if (!behaviour) throw new Error('no behaviour');
    if (behaviour.kind === 'fail') {
      throw new LlmProviderError(this.name, behaviour.error, 'boom', 500);
    }
    this.clock.t += behaviour.latencyMs ?? 100;
    return { text: '{"stance":"BULL"}', inputTokens: 1000, outputTokens: 500 };
  }
}

function setup(overrides?: {
  behaviours?: Partial<Record<ProviderName, Behaviour[]>>;
  spendUsd?: number;
  options?: Partial<LlmClientOptions>;
}) {
  const clock = new FakeClock();
  const runs: LlmRunRecord[] = [];
  const adapters = {
    anthropic: new FakeAdapter('anthropic', clock, overrides?.behaviours?.anthropic ?? [{ kind: 'ok' }]),
    openrouter: new FakeAdapter('openrouter', clock, overrides?.behaviours?.openrouter ?? [{ kind: 'ok' }]),
    openai: new FakeAdapter('openai', clock, overrides?.behaviours?.openai ?? [{ kind: 'ok' }]),
  };
  const client = new LlmClient({
    adapters,
    ledger: { record: async (run) => void runs.push(run) },
    spend: { monthToDateUsd: async () => overrides?.spendUsd ?? 0 },
    monthlyCapUsd: 100,
    clock,
    ...overrides?.options,
  });
  return { client, adapters, runs, clock };
}

const req = {
  role: 'technical_analyst' as const,
  system: 'You are…',
  user: 'bar data…',
  promptHash: 'abc123',
  stageBudgetMs: 30_000,
};

describe('LlmClient (BE-060)', () => {
  it('happy path: primary answers, ledger row written with cost', async () => {
    const { client, adapters, runs } = setup();
    const res = await client.invoke(req);
    expect(res.provider).toBe('anthropic');
    expect(res.model).toBe('claude-sonnet-5'); // non-PM default = standard tier
    expect(res.failedOver).toBe(false);
    expect(res.modelDowngraded).toBe(false);
    // 1000 in @$2/M + 500 out @$10/M = 0.007
    expect(res.costUsd).toBeCloseTo(0.007, 9);
    expect(adapters.anthropic.calls[0]?.timeoutMs).toBe(30_000);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      role: 'technical_analyst',
      promptHash: 'abc123',
      modelDowngraded: false,
      failedOver: false,
    });
  });

  it('PM defaults to the premium tier', async () => {
    const { client, runs } = setup();
    const res = await client.invoke({ ...req, role: 'pm' });
    expect(res.model).toBe('claude-opus-4-8');
    expect(runs[0]?.tier).toBe('premium');
  });

  it('5xx → exactly one fallback attempt with a 10s cap (never a fresh budget)', async () => {
    const { client, adapters } = setup({
      behaviours: { anthropic: [{ kind: 'fail', error: 'server' }] },
    });
    const res = await client.invoke(req);
    expect(res.provider).toBe('openrouter'); // next in §9.4 chain, same family
    expect(res.failedOver).toBe(true);
    expect(adapters.anthropic.calls).toHaveLength(1);
    expect(adapters.openrouter.calls).toHaveLength(1);
    expect(adapters.openrouter.calls[0]?.timeoutMs).toBe(10_000);
  });

  it('timeout → immediate failover, same capability tier', async () => {
    const { client, runs } = setup({
      behaviours: { anthropic: [{ kind: 'fail', error: 'timeout' }] },
    });
    const res = await client.invoke(req);
    expect(res.provider).toBe('openrouter');
    expect(res.tier).toBe('standard');
    expect(runs[0]?.failedOver).toBe(true);
  });

  it('429 → backoff (capped, exponential across consecutive 429s) then failover', async () => {
    const { client, clock } = setup({
      behaviours: {
        anthropic: [
          { kind: 'fail', error: 'rate_limit' },
          { kind: 'fail', error: 'rate_limit' },
        ],
      },
    });
    await client.invoke(req);
    expect(clock.slept).toEqual([1_000]);
    await client.invoke(req);
    expect(clock.slept).toEqual([1_000, 2_000]); // doubles, capped at 10s
  });

  it('primary + fallback both down → LlmExhaustedError; third provider NEVER tried', async () => {
    const { client, adapters } = setup({
      behaviours: {
        anthropic: [{ kind: 'fail', error: 'server' }],
        openrouter: [{ kind: 'fail', error: 'timeout' }],
      },
    });
    await expect(client.invoke(req)).rejects.toThrow(LlmExhaustedError);
    expect(adapters.openai.calls).toHaveLength(0); // one fallback only (§2.2)
  });

  it('cost cap ≥90%: non-PM drops one tier, flagged; PM keeps premium', async () => {
    const { client, runs } = setup({ spendUsd: 91 });
    const analyst = await client.invoke(req);
    expect(analyst.model).toBe('claude-haiku-4-5-20251001'); // standard → economy
    expect(analyst.modelDowngraded).toBe(true);
    expect(analyst.downgradeReason).toBe('cost_cap');
    const pm = await client.invoke({ ...req, role: 'pm' });
    expect(pm.model).toBe('claude-opus-4-8'); // PM retains premium until 95%
    expect(pm.modelDowngraded).toBe(false);
    expect(runs.map((r) => r.modelDowngraded)).toEqual([true, false]);
  });

  it('cost cap ≥95%: PM downgrades too', async () => {
    const { client } = setup({ spendUsd: 96 });
    const pm = await client.invoke({ ...req, role: 'pm' });
    expect(pm.model).toBe('claude-sonnet-5'); // premium → standard
    expect(pm.downgradeReason).toBe('cost_cap');
  });

  it('2 consecutive slow calls (p95 >15s in window) → reroute via OpenRouter one tier down', async () => {
    const { client, adapters } = setup({
      behaviours: { anthropic: [{ kind: 'ok', latencyMs: 16_000 }] },
    });
    await client.invoke(req);
    await client.invoke(req);
    const res = await client.invoke(req);
    expect(res.provider).toBe('openrouter');
    expect(res.model).toBe('anthropic/claude-haiku-4.5'); // standard → economy
    expect(res.downgradeReason).toBe('latency');
    expect(res.modelDowngraded).toBe(true);
    expect(adapters.anthropic.calls).toHaveLength(2); // third call never hit primary
  });

  it('per-agent provider override changes the chain head', async () => {
    const { client } = setup({
      options: { roleProviders: { technical_analyst: 'openai' } },
    });
    const res = await client.invoke(req);
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-5.6-terra');
  });

  it('providers without adapters are skipped in the chain', async () => {
    const clock = new FakeClock();
    const openai = new FakeAdapter('openai', clock, [{ kind: 'ok' }]);
    const client = new LlmClient({
      adapters: { openai },
      ledger: { record: async () => {} },
      spend: { monthToDateUsd: async () => 0 },
      monthlyCapUsd: 100,
      clock,
    });
    const res = await client.invoke(req); // default primary anthropic missing
    expect(res.provider).toBe('openai');
  });
});
