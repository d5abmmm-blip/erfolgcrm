/**
 * Журнал писем (email_messages): запись с шифрованием ПДн через pgcrypto.
 *
 * Единая точка записи и для ручных писем (модуль email), и для автоматических
 * (воркеры invoice-reminder / ticket-status-notify). Тема/тело/адреса — персональные
 * данные (152-ФЗ), поэтому шифруются на вставке (pgp_sym_encrypt), читаются только
 * через decryptSql. Сырой bytea наружу не отдаём.
 *
 * Зависит только от @erfolg/db (никаких импортов из modules/) — lib остаётся самодостаточным.
 */
import {
  getTenantEncryptionKey,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { sql } from 'drizzle-orm';
import { logger } from './logger';
import { maskEmail } from './mask';

export interface JournalEntry {
  direction?: 'out' | 'in';
  status: 'sent' | 'skipped' | 'failed' | 'received';
  to?: string | null;
  from?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  messageId?: string | null;
  /** Этап C — заголовки треда (технические Message-ID, не ПДн). */
  inReplyTo?: string | null;
  references?: string | null;
  threadId?: string | null;
  /** Этап C — письмо помечено как спам (reg.ru ***SPAM***). */
  isSpam?: boolean;
  relatedTicketId?: string | null;
  relatedClientId?: string | null;
  attachmentName?: string | null;
  attachmentKind?: string | null;
  error?: string | null;
  sentByUserId?: string | null;
  sentAt?: Date | null;
  receivedAt?: Date | null;
}

/**
 * Пишет строку в журнал писем. Возвращает id новой записи.
 * Бросает при ошибке БД — вызывающий решает, фатально ли это (для отправки писем — нет).
 */
export async function insertEmailMessage(
  db: Db,
  tenantId: string,
  entry: JournalEntry,
): Promise<string | null> {
  const key = getTenantEncryptionKey({ id: tenantId, kmsKeyId: null });
  const enc = (v: string | null | undefined) =>
    v == null ? sql`NULL` : sql`pgp_sym_encrypt(${v}::text, ${key})`;
  const ts = (d: Date | null | undefined) =>
    d == null ? sql`NULL` : sql`${d.toISOString()}::timestamptz`;

  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO email_messages (
        tenant_id, direction, status,
        to_addr_encrypted, from_addr_encrypted, subject_encrypted,
        body_text_encrypted, body_html_encrypted,
        message_id, in_reply_to, references_list, thread_id,
        related_ticket_id, related_client_id,
        attachment_name, attachment_kind, is_spam, error, sent_by_user_id, sent_at, received_at
      ) VALUES (
        ${tenantId}, ${entry.direction ?? 'out'}, ${entry.status},
        ${enc(entry.to)}, ${enc(entry.from)}, ${enc(entry.subject)},
        ${enc(entry.bodyText)}, ${enc(entry.bodyHtml)},
        ${entry.messageId ?? null}, ${entry.inReplyTo ?? null}, ${entry.references ?? null}, ${entry.threadId ?? null},
        ${entry.relatedTicketId ?? null}, ${entry.relatedClientId ?? null},
        ${entry.attachmentName ?? null}, ${entry.attachmentKind ?? null}, ${entry.isSpam ?? false},
        ${entry.error ?? null}, ${entry.sentByUserId ?? null},
        ${ts(entry.sentAt)}, ${ts(entry.receivedAt)}
      ) RETURNING id
    `);
    const arr = result as unknown as Array<{ id: string }>;
    return arr[0]?.id ?? null;
  });
}

/**
 * Best-effort обёртка: журналирование НИКОГДА не должно ронять отправку письма.
 * Используется в воркерах и сервисе отправки.
 */
export async function tryJournalEmail(
  db: Db,
  tenantId: string,
  entry: JournalEntry,
): Promise<void> {
  try {
    await insertEmailMessage(db, tenantId, entry);
  } catch (err) {
    logger.warn({ err, to: maskEmail(entry.to ?? '') }, 'email-journal: insert failed');
  }
}
