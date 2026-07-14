import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { processNotificationJob } from './notifications.js';
import type { NotificationJob } from './queues.js';
import { WS_FANOUT_CHANNEL } from './queues.js';

/**
 * BE-115/BE-118 — severity routing policy:
 *   critical → Telegram + Twilio SMS; warning/info → Telegram only;
 *   channel failure → surfaced over the `notifications` WS channel, job never throws.
 */

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    TRADING_MODE: 'paper',
    INTERNAL_API_TOKEN: 'test-internal-token-16ch',
    NEXTAUTH_SECRET: 'test-nextauth-secret-16ch',
    INTERNAL_SYNC_TOKEN: 'test-internal-sync-token-16ch',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://fx:fx@localhost:5432/fx',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    TELEGRAM_BOT_TOKEN: 'tg-token',
    TELEGRAM_CHAT_ID: 'chat-1',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'twilio-auth',
    TWILIO_FROM_NUMBER: '+15005550006',
    ALERT_SMS_TO: '+447700900000',
    ...overrides,
  });
}

function capturingFetch(failUrls: string[] = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (failUrls.some((f) => u.includes(f))) return new Response('boom', { status: 500 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

function fakeRedis() {
  const published: Array<{ channel: string; message: string }> = [];
  return {
    published,
    redis: {
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      },
    } as unknown as import('ioredis').Redis,
  };
}

const criticalJob: { data: NotificationJob } = {
  data: {
    severity: 'critical',
    title: 'KILL-SWITCH ACTIVATED',
    body: 'manual halt (by operator)',
    event: 'kill_switch',
  },
};

describe('processNotificationJob routing (BE-115/BE-118)', () => {
  it('critical → Telegram AND Twilio SMS', async () => {
    const { calls, impl } = capturingFetch();
    const res = await processNotificationJob(criticalJob, {
      env: testEnv(),
      fetchImpl: impl,
    });
    expect(res.telegramOk).toBe(true);
    expect(res.smsAttempted).toBe(true);
    expect(res.smsOk).toBe(true);
    expect(calls.some((c) => c.url.includes('api.telegram.org'))).toBe(true);
    const twilio = calls.find((c) => c.url.includes('api.twilio.com'));
    expect(twilio).toBeDefined();
    expect(String(twilio?.init?.body)).toContain('KILL-SWITCH');
  });

  it('warning → Telegram only, NO SMS (high-signal channel)', async () => {
    const { calls, impl } = capturingFetch();
    const res = await processNotificationJob(
      { data: { severity: 'warning', title: 'Partial fill', body: 'EUR_USD remainder 500' } },
      { env: testEnv(), fetchImpl: impl },
    );
    expect(res.smsAttempted).toBe(false);
    expect(calls.some((c) => c.url.includes('api.twilio.com'))).toBe(false);
    expect(calls.some((c) => c.url.includes('api.telegram.org'))).toBe(true);
  });

  it('unconfigured channels are inert, not failures (mock-first)', async () => {
    const { calls, impl } = capturingFetch();
    const res = await processNotificationJob(criticalJob, {
      env: testEnv({
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_FROM_NUMBER: '',
        ALERT_SMS_TO: '',
      }),
      fetchImpl: impl,
    });
    expect(calls).toHaveLength(0);
    expect(res.telegramOk).toBe(true);
    expect(res.smsOk).toBe(true);
  });

  it('a Twilio failure is surfaced on the notifications WS channel (BE-118 AC)', async () => {
    const { impl } = capturingFetch(['api.twilio.com']);
    const { redis, published } = fakeRedis();
    const res = await processNotificationJob(criticalJob, {
      env: testEnv(),
      redis,
      fetchImpl: impl,
    });
    expect(res.smsOk).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(WS_FANOUT_CHANNEL);
    const frame = JSON.parse(published[0]?.message ?? '{}');
    expect(frame.channel).toBe('notifications');
    expect(frame.payload.event).toBe('notification:send_failed');
    expect(frame.payload.channel).toBe('sms');
  });

  it('a Telegram failure never throws into BullMQ (no retry storm)', async () => {
    const { impl } = capturingFetch(['api.telegram.org']);
    const { redis, published } = fakeRedis();
    const res = await processNotificationJob(
      { data: { severity: 'info', title: 'Order filled', body: 'XAU_USD long 100' } },
      { env: testEnv(), redis, fetchImpl: impl },
    );
    expect(res.telegramOk).toBe(false);
    expect(JSON.parse(published[0]?.message ?? '{}').payload?.channel).toBe('telegram');
  });
});
