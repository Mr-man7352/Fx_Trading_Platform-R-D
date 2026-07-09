import { describe, expect, it } from 'vitest';
import { PromptRegistry, promptHash, requiresRevalidation } from './registry.js';

/** BE-061 — prompt registry + snapshot pinning tests. */

describe('promptHash', () => {
  const base = { role: 'trader' as const, version: 1, system: 'Decide ENTER/HOLD/EXIT.' };

  it('is deterministic', () => {
    expect(promptHash(base)).toBe(promptHash({ ...base }));
  });

  it('changes when the version bumps', () => {
    expect(promptHash({ ...base, version: 2 })).not.toBe(promptHash(base));
  });

  it('changes when the prompt text changes', () => {
    expect(promptHash({ ...base, system: 'Different.' })).not.toBe(promptHash(base));
  });
});

describe('PromptRegistry', () => {
  it('registers and returns hash + contract version', () => {
    const registry = new PromptRegistry();
    const prompt = registry.register({ role: 'pm', version: 1, system: 'You are the PM.' });
    expect(prompt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.get('pm').hash).toBe(prompt.hash);
    expect(registry.has('trader')).toBe(false);
  });

  it('rejects a text change without a version bump', () => {
    const registry = new PromptRegistry();
    registry.register({ role: 'pm', version: 1, system: 'v1 text' });
    expect(() => registry.register({ role: 'pm', version: 1, system: 'edited text' })).toThrow(
      /version bump/,
    );
    expect(() => registry.register({ role: 'pm', version: 2, system: 'edited text' })).not.toThrow();
  });

  it('throws on unregistered role (plumbing error, not a HOLD)', () => {
    expect(() => new PromptRegistry().get('bull_researcher')).toThrow(/No prompt registered/);
  });
});

describe('requiresRevalidation (BE-061 acceptance)', () => {
  const prev = { provider: 'anthropic', model: 'claude-sonnet-5', promptHash: 'aaa' };

  it('no change → no re-validation', () => {
    expect(requiresRevalidation(prev, { ...prev })).toEqual({ revalidate: false, reasons: [] });
  });

  it('provider change flags re-validation', () => {
    const res = requiresRevalidation(prev, { ...prev, provider: 'openai' });
    expect(res.revalidate).toBe(true);
    expect(res.reasons).toContain('provider_changed');
  });

  it('model snapshot or prompt hash change flags re-validation', () => {
    expect(
      requiresRevalidation(prev, { ...prev, model: 'claude-sonnet-6' }).reasons,
    ).toContain('model_snapshot_changed');
    expect(requiresRevalidation(prev, { ...prev, promptHash: 'bbb' }).reasons).toContain(
      'prompt_hash_changed',
    );
  });
});
