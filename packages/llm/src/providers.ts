import type { ProviderName } from './catalog.js';
import { LlmProviderError } from './errors.js';

/**
 * BE-060 — thin fetch adapters, one per provider. Uniform surface: temp 0,
 * JSON output requested where the API supports it natively (OpenAI /
 * OpenRouter / Gemini); Anthropic JSON discipline comes from the prompt and
 * every output is Zod-validated downstream regardless (BE-069) — the schema
 * is the contract, not the provider's JSON mode.
 *
 * No SDKs, no built-in retries: retry/failover policy lives in ONE place
 * (factory.ts) so the §2.2 budget arithmetic stays deterministic.
 */

export interface ChatParams {
  /** Exact pinned snapshot ID (catalog resolves it — never hardcode). */
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  chat(params: ChatParams): Promise<ChatResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function classifyStatus(provider: ProviderName, status: number, body: string): LlmProviderError {
  const msg = `HTTP ${status}: ${body.slice(0, 300)}`;
  if (status === 429) return new LlmProviderError(provider, 'rate_limit', msg, status);
  if (status >= 500) return new LlmProviderError(provider, 'server', msg, status);
  return new LlmProviderError(provider, 'fatal', msg, status);
}

async function post(
  provider: ProviderName,
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new LlmProviderError(provider, 'timeout', `no response within ${timeoutMs}ms`);
    }
    throw new LlmProviderError(
      provider,
      'server',
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw classifyStatus(provider, res.status, await res.text());
  return (await res.json()) as Record<string, unknown>;
}

/** Anthropic Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async chat(p: ChatParams): Promise<ChatResult> {
    const json = await post(
      this.name,
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: p.model,
        max_tokens: p.maxTokens,
        temperature: 0,
        system: p.system,
        messages: [{ role: 'user', content: p.user }],
      },
      p.timeoutMs,
    );
    const content = json.content as Array<{ type: string; text?: string }> | undefined;
    const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      text: content?.find((c) => c.type === 'text')?.text ?? '',
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  }
}

/** OpenAI-compatible chat/completions — shared by OpenAI and OpenRouter. */
abstract class OpenAiCompatibleAdapter implements ProviderAdapter {
  abstract readonly name: ProviderName;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async chat(p: ChatParams): Promise<ChatResult> {
    const json = await post(
      this.name,
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: p.model,
        max_tokens: p.maxTokens,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
      },
      p.timeoutMs,
    );
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    return {
      text: choices?.[0]?.message?.content ?? '',
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }
}

export class OpenAiAdapter extends OpenAiCompatibleAdapter {
  readonly name = 'openai' as const;
  constructor(apiKey: string, fetchImpl: FetchLike = fetch) {
    super(apiKey, fetchImpl, 'https://api.openai.com/v1');
  }
}

export class OpenRouterAdapter extends OpenAiCompatibleAdapter {
  readonly name = 'openrouter' as const;
  constructor(apiKey: string, fetchImpl: FetchLike = fetch) {
    super(apiKey, fetchImpl, 'https://openrouter.ai/api/v1');
  }
}

/** Google Gemini generateContent API. */
export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini' as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {}

  async chat(p: ChatParams): Promise<ChatResult> {
    const json = await post(
      this.name,
      this.fetchImpl,
      `${this.baseUrl}/models/${p.model}:generateContent`,
      { 'x-goog-api-key': this.apiKey },
      {
        systemInstruction: { parts: [{ text: p.system }] },
        contents: [{ role: 'user', parts: [{ text: p.user }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: p.maxTokens,
          responseMimeType: 'application/json',
        },
      },
      p.timeoutMs,
    );
    const candidates = json.candidates as
      | Array<{ content?: { parts?: Array<{ text?: string }> } }>
      | undefined;
    const usage = (json.usageMetadata ?? {}) as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
    return {
      text: candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  }
}
