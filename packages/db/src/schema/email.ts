/**
 * Раздел «Почта» (Этап A — исходящие + журнал).
 *
 * email_configs — реквизиты ОБЩЕГО ящика компании (один на tenant, модель — onec_configs).
 *   Закладываем сразу SMTP (отправка) и IMAP (входящие, Этап B) — чтобы не переделывать миграцию.
 *   Пароли — ПДн-уровня секрет, шифруются через pgcrypto (bytea), как ФИО/телефон клиентов.
 *
 * email_messages — журнал/хранилище писем. Проектируем сразу под обе стороны (direction
 *   'out'|'in'), Этап B (входящие по IMAP) переиспользует таблицу. Тема/тело/адреса —
 *   персональные данные (152-ФЗ), поэтому шифруются (см. crypto.ts decryptSql/pgp_sym_encrypt).
 *   Сами вложения в БД НЕ храним — они регенерируются из заявки; пишем только метаданные.
 *
 * RLS включается отдельно через 0042_enable_rls_email.sql (setup-rls.ts).
 */
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { encryptedText, fkUuid, pk, tenantId, timestamps } from './_shared';

/** Реквизиты общего почтового ящика компании. Одна строка на tenant. */
export const emailConfigs = pgTable('email_configs', {
  tenantId: tenantId().primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** Отображаемое имя и адрес отправителя («ООО Эрфольг» <erfolgmt@…>). */
  fromName: varchar('from_name', { length: 200 }),
  fromEmail: varchar('from_email', { length: 320 }),

  // SMTP — исходящие (Этап A)
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port'),
  smtpSecure: boolean('smtp_secure').notNull().default(true),
  smtpUser: varchar('smtp_user', { length: 320 }),
  smtpPasswordEnc: encryptedText('smtp_password_encrypted'),

  // IMAP — входящие (Этап B, поля закладываем заранее)
  imapHost: varchar('imap_host', { length: 255 }),
  imapPort: integer('imap_port'),
  imapSecure: boolean('imap_secure').notNull().default(true),
  imapUser: varchar('imap_user', { length: 320 }),
  imapPasswordEnc: encryptedText('imap_password_encrypted'),

  // Состояние инкрементальной выборки входящих (Этап B): последний обработанный UID
  // и время последней синхронизации с ящиком.
  imapLastUid: bigint('imap_last_uid', { mode: 'number' }),
  imapLastFetchAt: timestamp('imap_last_fetch_at', { withTimezone: true }),

  // Полноценный клиент (0045): подпись компании, подставляется в конец письма.
  // Не ПДн в обычном смысле — уходит в каждом письме, храним открытым текстом.
  signature: text('signature'),

  ...timestamps,
});

/** Журнал писем: исходящие (Этап A) + входящие (Этап B). */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Направление: исходящее (out) или входящее (in). */
    direction: varchar('direction', { length: 8 }).$type<'out' | 'in'>().notNull().default('out'),
    /** Статус: отправлено / пропущено (SMTP не настроен) / ошибка / получено (входящее)
     *  / черновик (draft) / запланировано (scheduled). */
    status: varchar('status', { length: 16 })
      .$type<'sent' | 'skipped' | 'failed' | 'received' | 'draft' | 'scheduled'>()
      .notNull(),

    /**
     * Переписка с клиентами. Хранится ОТКРЫТО — см. миграцию 0079.
     * Ключ шифрования лежал на том же сервере, что и база, поэтому от её кражи
     * не защищал, а его потеря делала переписку нечитаемой навсегда. Вдобавок
     * фильтр поиска расшифровывал каждую строку дважды за запрос (~9 сек на 5000 писем).
     */
    toAddr: text('to_addr'),
    fromAddr: text('from_addr'),
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),

    /* Шифрованные колонки-предшественники (0079) удалены уборкой 0081 —
       данные давно живут в открытых полях выше. */

    messageId: varchar('message_id', { length: 512 }),
    /** Привязка к заявке/клиенту (опционально). */
    relatedTicketId: uuid('related_ticket_id'),
    relatedClientId: uuid('related_client_id'),
    /** Метаданные вложения (сам файл не храним). */
    attachmentName: varchar('attachment_name', { length: 255 }),
    attachmentKind: varchar('attachment_kind', { length: 32 }),
    /** Текст ошибки при status='failed'. */
    error: text('error'),
    /** Кто отправил (для ручных писем). NULL для автоматических. */
    sentByUserId: uuid('sent_by_user_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),

    // ── Этап C: треды, чтение, спам ───────────────────────────────
    /** In-Reply-To: Message-ID родительского письма. Технический ID, не ПДн. */
    inReplyTo: varchar('in_reply_to', { length: 512 }),
    /** References: цепочка Message-ID через пробел (группировка треда). Не ПДн. */
    references: text('references_list'),
    /** Ключ треда — корневой Message-ID (references[0] || inReplyTo || свой messageId). */
    threadId: varchar('thread_id', { length: 512 }),
    /** Время прочтения (NULL = непрочитано). Актуально для входящих. */
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Спам: reg.ru помечает ***SPAM*** в теме — прячем из «Входящих». */
    isSpam: boolean('is_spam').notNull().default(false),

    // ── Полноценный клиент (0045): черновики, отложенная отправка, копии ──
    // Корзина — через стандартный deletedAt из ...timestamps (мягкое удаление).
    /** Копия (CC). Открыто, как и остальная переписка — см. миграцию 0079. */
    ccAddr: text('cc_addr'),
    /** Скрытая копия (BCC). Открыто. */
    bccAddr: text('bcc_addr'),
    /** Время отложенной отправки (status='scheduled'); NULL у обычных писем. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    index('email_messages_tenant_created_idx').on(t.tenantId, sql`${t.createdAt} DESC`),
    index('email_messages_thread_idx').on(t.tenantId, t.threadId),
    // Отложенные письма: быстрый разбор папки «Запланированные» и реконсиляция воркера.
    index('email_messages_scheduled_idx')
      .on(t.tenantId, t.scheduledAt)
      .where(sql`${t.scheduledAt} IS NOT NULL`),
    check('email_messages_direction_chk', sql`direction IN ('out','in')`),
    check(
      'email_messages_status_chk',
      sql`status IN ('sent','skipped','failed','received','draft','scheduled')`,
    ),
  ],
);

/**
 * Вложения входящих писем (Этап C). Сам файл лежит в object-storage (S3/local),
 * здесь — только метаданные + ключ объекта. Скачивание — через presigned GET URL.
 * Имя файла храним plaintext (как в таблице attachments); содержимое — в S3.
 */
export const emailAttachments = pgTable(
  'email_attachments',
  {
    id: pk(),
    tenantId: tenantId(),
    /** FK на email_messages.id (письмо, к которому относится вложение). */
    messageId: fkUuid('message_id'),
    /** Ключ объекта: tenants/<id>/email_inbound/email_message/<msgId>/<uuid>-<name>. */
    objectKey: varchar('object_key', { length: 500 }).notNull(),
    originalName: varchar('original_name', { length: 300 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_attachments_tenant_msg_idx').on(t.tenantId, t.messageId)],
);
