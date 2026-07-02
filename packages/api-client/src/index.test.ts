import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('returns Zod-validated typed responses', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: 'ok', commit: 'abc', uptime: 1, tradingMode: 'paper' }),
    );
    const client = createApiClient({ baseUrl: 'http://api', fetchImpl });
    const health = await client.health.get();
    expect(health.tradingMode).toBe('paper');
  });

  it('rejects contract drift loudly', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    const client = createApiClient({ baseUrl: 'http://api', fetchImpl });
    await expect(client.health.get()).rejects.toThrow();
  });

  it('fires onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'nope' } }),
    );
    const client = createApiClient({ baseUrl: 'http://api', fetchImpl, onUnauthorized });
    await expect(client.health.get()).rejects.toBeInstanceOf(ApiClientError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('fires onStepUpRequired on 403 STEP_UP_2FA_REQUIRED', async () => {
    const onStepUpRequired = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { code: 'STEP_UP_2FA_REQUIRED', message: 'step up' } }),
    );
    const client = createApiClient({ baseUrl: 'http://api', fetchImpl, onStepUpRequired });
    await expect(client.trades.list()).rejects.toBeInstanceOf(ApiClientError);
    expect(onStepUpRequired).toHaveBeenCalledOnce();
  });
});
