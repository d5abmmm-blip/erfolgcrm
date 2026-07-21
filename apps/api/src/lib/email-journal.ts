/**
 * Журнал писем (email_messages): запись с шифрованием ПДн через pgcrypto.
 *
 * Единая точка записи и для ручных писем (модуль email), и для автоматических
 * (воркеры invoice-reminder / ticket-status-notify). Тема, тело и адреса хранятся
 * ОТКРЫТО — см. миграцию 0079: ключ шифрования лежал на том же сервере, что и база,
 * а расшифровка каждой строки делала поиск по почте неприемлемо медленным.
 * Зашифрованными остались только пароли ящика в email_configs.
 *
 * Зависит только от @erfolg/db (никаких импортов из modules/) — lib остаётся самодостаточным.
 */
import {
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
  cc?: string | null;
  bcc?: string | null;
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
  const ts = (d: Date | null | undefined) =>
    d == null ? sql`NULL` : sql`${d.toISOString()}::timestamptz`;

  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO email_messages (
        tenant_id, direction, status,
        to_addr, from_addr, cc_addr, bcc_addr, subject,
        body_text, body_html,
        message_id, in_reply_to, references_list, thread_id,
        related_ticket_id, related_client_id,
        attachment_name, attachment_kind, is_spam, error, sent_by_user_id, sent_at, received_at
      ) VALUES (
        ${tenantId}, ${entry.direction ?? 'out'}, ${entry.status},
        ${entry.to ?? null}, ${entry.from ?? null}, ${entry.cc ?? null}, ${entry.bcc ?? null}, ${entry.subject ?? null},
        ${entry.bodyText ?? null}, ${entry.bodyHtml ?? null},
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
