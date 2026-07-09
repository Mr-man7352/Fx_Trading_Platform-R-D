import { describe, expect, it } from 'vitest';
import { LlmProviderError } from './errors.js';
import { AnthropicAdapter, type FetchLike, GeminiAdapter, OpenAiAdapter } from './providers.js';

/** BE-060 — request shaping + error classification per adapter. */

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls };
}

const params = {
  model: 'pinned-model',
  system: 'sys',
  user: 'usr',
  maxTokens: 512,
  timeoutMs: 5_000,
};

describe('AnthropicAdapter', () => {
  it('shapes the Messages API request with temperature 0', async () => {
    const { impl, calls } = fakeFetch(200, {
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const res = await new AnthropicAdapter('key', impl).chat(params);
    expect(res).toEqual({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5 });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toMatchObject({ model: 'pinned-model', temperature: 0, max_tokens: 512 });
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('key');
  });

  it('classifies 429 as rate_limit and 500 as server', async () => {
    for (const [status, kind] of [
      [429, 'rate_limit'],
      [500, 'server'],
      [401, 'fatal'],
    ] as const) {
      const { impl } = fakeFetch(status, {});
      const err = await new AnthropicAdapter('key', impl).chat(params).catch((e) => e);
      expect(err).toBeInstanceOf(LlmProviderError);
      expect((err as LlmProviderError).kind).toBe(kind);
    }
  });

  it('classifies an aborted request as timeout', async () => {
    const impl: FetchLike = async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    };
    const err = await new AnthropicAdapter('key', impl).chat(params).catch((e) => e);
    expect((err as LlmProviderError).kind).toBe('timeout');
  });
});

describe('OpenAiAdapter', () => {
  it('requests strict JSON mode and parses usage', async () => {
    const { impl, calls } = fakeFetch(200, {
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const res = await new OpenAiAdapter('key', impl).chat(params);
    expect(res).toEqual({ text: '{"a":1}', inputTokens: 7, outputTokens: 3 });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
  });
});

describe('GeminiAdapter', () => {
  it('requests application/json output and parses usageMetadata', async () => {
    const { impl, calls } = fakeFetch(200, {
      candidates: [{ content: { parts: [{ text: '{"b":2}' }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    });
    const res = await new GeminiAdapter('key', impl).chat(params);
    expect(res).toEqual({ text: '{"b":2}', inputTokens: 4, outputTokens: 2 });
    expect(calls[0]?.url).toContain('models/pinned-model:generateContent');
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: 'application/json',
    });
  });
});
