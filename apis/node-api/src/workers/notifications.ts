import type { Job } from 'bullmq';
import type { Env } from '../env.js';
import type { NotificationJob } from './queues.js';

/** BE-050 — minimal notification worker (full Telegram bot is BE-115). */

export async function processNotificationJob(job: Job<NotificationJob>, env: Env): Promise<void> {
  const { severity, title, body, event } = job.data;
  console.log(`[notification:${severity}] ${title}: ${body}${event ? ` (${event})` : ''}`);

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text = `*${title}*\n${body}`;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('telegram send failed', err);
  }
}
