import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../env.js';
import type { NotificationJob } from './queues.js';
import { publishWsEvent } from './ws-publish.js';

/**
 * BE-115/BE-118 — the notification worker (replaces the BE-050 minimal seam).
 *
 * Routing policy:
 *   - every severity  → Telegram (when configured) + console log
 *   - critical ONLY   → additionally Twilio SMS (kill-switch, reconciliation
 *     mismatch, circuit open, dead-man, daily DD halt). Warning/info never
 *     SMS — the SMS channel stays high-signal (BE-118 AC).
 *   - any channel failure → logged AND surfaced on the dashboard via the
 *     `notifications` WS channel (alerting-about-alerting, BE-118 AC).
 *
 * Both senders are mock-first: missing env keys make the channel inert
 * without failing the job (matches the OANDA/LLM/Resend convention).
 * Neither sender throws into BullMQ — a notification failure must never
 * poison the queue with retry storms; surfacing IS the failure handling.
 */

export interface NotificationDeps {
  env: Env;
  /** For WS surfacing of send failures; optional so tests can omit it. */
  redis?: Redis | null;
  fetchImpl?: typeof fetch;
}

/** Telegram MarkdownV2 requires escaping; use plain text + HTML-free body. */
function telegramText(job: NotificationJob): string {
  const icon = job.severity === 'critical' ? '🔴' : job.severity === 'warning' ? '🟠' : '🔵';
  const eventLine = job.event ? `\n#${job.event.replaceAll('.', '_')}` : '';
  return `${icon} ${job.title}\n${job.body}${eventLine}`;
}

async function sendTelegram(deps: NotificationDeps, job: NotificationJob): Promise<boolean> {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = deps.env;
  if (!token || !chatId) return true; // channel not configured — not a failure
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramText(job) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] telegram send failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] telegram send failed:', err);
    return false;
  }
}

function smsConfigured(env: Env): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER && env.ALERT_SMS_TO,
  );
}

/** BE-118 — Twilio REST (no SDK dep): form-encoded POST with basic auth. */
async function sendSms(deps: NotificationDeps, job: NotificationJob): Promise<boolean> {
  const { env } = deps;
  if (!smsConfigured(env)) return true; // channel not configured — not a failure
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const body = new URLSearchParams({
    To: env.ALERT_SMS_TO as string,
    From: env.TWILIO_FROM_NUMBER as string,
    Body: `[FX ${env.TRADING_MODE}] ${job.title} — ${job.body}`.slice(0, 320),
  });
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[notify] twilio send failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] twilio send failed:', err);
    return false;
  }
}

/** Surface a channel failure on the dashboard (`notifications` WS channel). */
async function surfaceFailure(
  deps: NotificationDeps,
  channel: 'telegram' | 'sms',
  job: NotificationJob,
): Promise<void> {
  if (!deps.redis) return;
  try {
    await publishWsEvent(deps.redis, 'notifications', {
      event: 'notification:send_failed',
      channel,
      severity: job.severity,
      title: job.title,
      originalEvent: job.event ?? null,
    });
  } catch (err) {
    console.error('[notify] failed to surface send failure over WS:', err);
  }
}

export interface NotificationResult {
  telegramOk: boolean;
  smsAttempted: boolean;
  smsOk: boolean;
}

export async function processNotificationJob(
  job: Job<NotificationJob> | { data: NotificationJob },
  deps: NotificationDeps,
): Promise<NotificationResult> {
  const data = job.data;
  const { severity, title, body, event } = data;
  console.log(`[notification:${severity}] ${title}: ${body}${event ? ` (${event})` : ''}`);

  const telegramOk = await sendTelegram(deps, data);
  if (!telegramOk) await surfaceFailure(deps, 'telegram', data);

  // BE-118 — SMS escalation for CRITICAL only; warning/info stay Telegram-only.
  let smsOk = true;
  const smsAttempted = severity === 'critical' && smsConfigured(deps.env);
  if (severity === 'critical') {
    smsOk = await sendSms(deps, data);
    if (!smsOk) await surfaceFailure(deps, 'sms', data);
  }

  return { telegramOk, smsAttempted, smsOk };
}
