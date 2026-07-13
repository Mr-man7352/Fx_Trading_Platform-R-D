import { Resend } from 'resend';

/**
 * BE-034 — transactional email. With `RESEND_API_KEY` set, mail goes through
 * Resend; without it (dev/CI, mock-first like OANDA/LLM) the message is logged
 * so flows are fully testable offline. Callers never branch on which path ran.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

export interface EmailLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface EmailConfig {
  resendApiKey?: string;
  from: string;
  appBaseUrl: string;
}

class ResendSender implements EmailSender {
  private readonly client: Resend;
  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly log: EmailLogger,
  ) {
    this.client = new Resend(apiKey);
  }
  async send(msg: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
    if (error) {
      this.log.error({ err: error, to: msg.to }, 'resend email failed');
      throw new Error(`Email delivery failed: ${error.message}`);
    }
  }
}

class LogSender implements EmailSender {
  constructor(private readonly log: EmailLogger) {}
  async send(msg: EmailMessage): Promise<void> {
    // Loud enough to grab the link from dev logs; RESEND_API_KEY unset is expected in dev.
    this.log.info(
      { email: true, to: msg.to, subject: msg.subject, body: msg.text },
      'email (mock)',
    );
  }
}

export function createEmailSender(config: EmailConfig, log: EmailLogger): EmailSender {
  return config.resendApiKey
    ? new ResendSender(config.resendApiKey, config.from, log)
    : new LogSender(log);
}

// ── Message builders (BE-034) ────────────────────────────────────────────────

export function verificationEmail(baseUrl: string, to: string, token: string): EmailMessage {
  const link = `${baseUrl}/verify?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'Verify your FX Platform email',
    text: `Confirm your email to finish setting up your account:\n\n${link}\n\nThis link expires shortly. If you didn't request it, ignore this message.`,
  };
}

export function passwordResetEmail(baseUrl: string, to: string, token: string): EmailMessage {
  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'Reset your FX Platform password',
    text: `Reset your password using the link below:\n\n${link}\n\nThis link expires shortly. If you didn't request it, your account is still secure — ignore this message.`,
  };
}
