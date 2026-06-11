/**
 * SMTP-фасад над nodemailer.
 *
 * Production: Yandex SMTP / SES / другой провайдер РФ (для медданных запрещены OpenAI/Anthropic,
 * SMTP технически нейтрален, но клиенту лучше использовать российский почтовый сервис).
 * Dev: MailHog на localhost:1025 (см. docker-compose.dev.yml). Все письма ловятся в Web UI :8025.
 *
 * ENV:
 *   SMTP_HOST=mailhog (или smtp.yandex.ru)
 *   SMTP_PORT=1025
 *   SMTP_SECURE=false  (true для 465)
 *   SMTP_USER=...      (опционально, для auth)
 *   SMTP_PASSWORD=...
 *   MAIL_FROM=erfolgmt@mail.ru  (default отправитель)
 *
 * Отказ от отправки: если SMTP_HOST не задан — sendMail возвращает { skipped: true }.
 * Это нужно чтобы в тестах и в локальных запусках без MailHog система не падала.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from './logger';
import { maskEmail } from './mask';

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Override отправителя. По умолчанию MAIL_FROM. */
  from?: string;
  /** Тестовый режим: не отправлять реально, просто валидировать. */
  dryRun?: boolean;
}

export interface SendMailResult {
  skipped: boolean;
  messageId?: string;
  reason?: string;
}

let _transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 1025);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    // На dev MailHog HELO без TLS, не требует STARTTLS.
    ignoreTLS: !secure && host === 'localhost',
  });
  return _transporter;
}

const DEFAULT_FROM = 'noreply@erfolgcrm.local';

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (input.dryRun) {
    return { skipped: true, reason: 'dry-run' };
  }
  const transporter = getTransporter();
  if (!transporter) {
    // 152-ФЗ: маскируем email в логах, чтобы не утекал в Sentry/CloudWatch.
    logger.warn({ to: maskEmail(input.to), subject: input.subject }, 'sendMail: SMTP_HOST not set, skipping');
    return { skipped: true, reason: 'smtp-not-configured' };
  }
  const from = input.from ?? process.env.MAIL_FROM ?? DEFAULT_FROM;
  try {
    const info = (await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })) as { messageId?: string };
    logger.info({ messageId: info.messageId, to: maskEmail(input.to), subject: input.subject }, 'mail sent');
    return { skipped: false, messageId: info.messageId };
  } catch (err) {
    logger.warn({ err, to: maskEmail(input.to), subject: input.subject }, 'sendMail failed');
    throw err;
  }
}

/** Закрыть transporter — для graceful shutdown. */
export function shutdownMailer(): Promise<void> {
  if (_transporter) {
    _transporter.close();
    _transporter = null;
  }
  return Promise.resolve();
}

/** Тест-only: подменить transporter (для unit-тестов). */
export function __setTransporterForTesting(t: Transporter | null): void {
  _transporter = t;
}
