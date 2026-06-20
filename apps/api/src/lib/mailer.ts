/**
 * SMTP-фасад над nodemailer.
 *
 * Production: почта компании на своём домене (reg.ru / Yandex / др. РФ-провайдер). Реквизиты
 * берутся из email_configs (per-tenant, пароль шифруется) — см. sendMailVia с явным transport.
 * Dev: MailHog на localhost:1025 (см. docker-compose.dev.yml). Все письма ловятся в Web UI :8025.
 *
 * Два пути отправки:
 *   - sendMail(input)            — транспорт из ENV (SMTP_HOST...). Используют воркеры/дефолт.
 *   - sendMailVia(transport, in) — транспорт из явного конфига (ящик tenant'а) ИЛИ ENV (transport=null).
 * В обоих случаях инъектированный тест-транспорт (__setTransporterForTesting) имеет приоритет.
 *
 * ENV (дефолтный транспорт):
 *   SMTP_HOST=localhost (или mailhog/smtp.yandex.ru)
 *   SMTP_PORT=1025
 *   SMTP_SECURE=false  (true для 465)
 *   SMTP_USER=...      (опционально, для auth)
 *   SMTP_PASSWORD=...
 *   MAIL_FROM=erfolgmt@mail.ru  (default отправитель)
 *
 * Отказ от отправки: если транспорт не сконфигурирован — возвращаем { skipped: true }.
 * Это нужно чтобы в тестах и в локальных запусках без MailHog система не падала.
 */
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from './logger';
import { maskEmail } from './mask';

// Предпочитать IPv4 при DNS-резолве. На хостах без IPv6-маршрута (локальные машины,
// часть VPS) соединение по AAAA падает с ENETUNREACH; Node 17+ по умолчанию не
// приоритизирует IPv4. Почтовые серверы (reg.ru и пр.) всегда имеют A-запись.
dns.setDefaultResultOrder('ipv4first');

export interface MailAttachment {
  filename: string;
  /** Содержимое в base64 (без data:-префикса). */
  content: string;
  contentType?: string;
}

export interface SendMailInput {
  to: string;
  /** Копия / скрытая копия (один или несколько адресов через запятую). */
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  /** Override отправителя. По умолчанию transport.from / MAIL_FROM. */
  from?: string;
  attachments?: MailAttachment[];
  /** Этап C — заголовок In-Reply-To (Message-ID родителя) для ответов в треде. */
  inReplyTo?: string;
  /** Этап C — заголовок References (цепочка Message-ID) для группировки треда. */
  references?: string | string[];
  /** Тестовый режим: не отправлять реально, просто валидировать. */
  dryRun?: boolean;
}

export interface SendMailResult {
  skipped: boolean;
  messageId?: string;
  reason?: string;
}

/** Явный транспорт для отправки через ящик конкретного tenant'а (из email_configs). */
export interface SmtpTransport {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  pass?: string | null;
  from?: string | null;
}

/** Тест-override (через __setTransporterForTesting). Имеет приоритет над ENV и явным конфигом. */
let _testTransporter: Transporter | null = null;
/** Кэш ENV-транспорта (строится один раз). */
let _envTransporter: Transporter | null = null;

function getEnvTransporter(): Transporter | null {
  if (_envTransporter) return _envTransporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 1025);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  _envTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    // На dev MailHog HELO без TLS, не требует STARTTLS.
    ignoreTLS: !secure && (host === 'localhost' || host === 'mailhog'),
  });
  return _envTransporter;
}

function buildTransporter(t: SmtpTransport): Transporter {
  return nodemailer.createTransport({
    host: t.host,
    port: t.port,
    secure: t.secure,
    auth: t.user && t.pass ? { user: t.user, pass: t.pass } : undefined,
    ignoreTLS: !t.secure && (t.host === 'localhost' || t.host === 'mailhog'),
  });
}

const DEFAULT_FROM = 'noreply@erfolgcrm.local';

function toNodemailerAttachments(attachments?: MailAttachment[]) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    encoding: 'base64' as const,
    contentType: a.contentType ?? 'application/octet-stream',
  }));
}

/**
 * Отправка с явным транспортом (ящик tenant'а) или из ENV (transport=null).
 * Тест-транспорт, если внедрён, перекрывает оба.
 */
export async function sendMailVia(
  transport: SmtpTransport | null,
  input: SendMailInput,
): Promise<SendMailResult> {
  if (input.dryRun) {
    return { skipped: true, reason: 'dry-run' };
  }
  const transporter =
    _testTransporter ?? (transport ? buildTransporter(transport) : getEnvTransporter());
  if (!transporter) {
    // 152-ФЗ: маскируем email в логах, чтобы не утекал в Sentry/CloudWatch.
    logger.warn(
      { to: maskEmail(input.to), subject: input.subject },
      'sendMail: транспорт не сконфигурирован, пропускаем',
    );
    return { skipped: true, reason: 'smtp-not-configured' };
  }
  const from = input.from ?? transport?.from ?? process.env.MAIL_FROM ?? DEFAULT_FROM;
  try {
    const info = (await transporter.sendMail({
      from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: toNodemailerAttachments(input.attachments),
      // Этап C: заголовки треда — клиенты получателя сгруппируют переписку в ветку.
      inReplyTo: input.inReplyTo,
      references: input.references,
    })) as { messageId?: string };
    logger.info(
      { messageId: info.messageId, to: maskEmail(input.to), subject: input.subject },
      'mail sent',
    );
    return { skipped: false, messageId: info.messageId };
  } catch (err) {
    logger.warn(
      { err, to: maskEmail(input.to), subject: input.subject },
      'sendMail failed',
    );
    throw err;
  }
}

/** Отправка через ENV-транспорт (или тест-override). Совместимость со старыми вызовами (воркеры). */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  return sendMailVia(null, input);
}

/** Закрыть transporter — для graceful shutdown. */
export function shutdownMailer(): Promise<void> {
  if (_envTransporter) {
    _envTransporter.close();
    _envTransporter = null;
  }
  return Promise.resolve();
}

/** Тест-only: подменить transporter (для unit-тестов). Перекрывает ENV и явный конфиг. */
export function __setTransporterForTesting(t: Transporter | null): void {
  _testTransporter = t;
}
