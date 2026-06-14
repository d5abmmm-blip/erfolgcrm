/**
 * Repository слой раздела «Почта». Чистые DB-функции.
 *
 * Все запросы — через withTenantTx (RLS включён на email_configs / email_messages).
 * Пароли и тело/тема/адреса — ПДн, шифруются через pgcrypto. Наружу сырой bytea не отдаём:
 * пароли — только флагом hasPassword, тело/тема/адрес — расшифрованными через decryptSql.
 */
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  decryptSql,
  emailAttachments,
  emailConfigs,
  emailMessages,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export interface EmailConfigDto {
  enabled: boolean;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  hasSmtpPassword: boolean;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  imapUser: string | null;
  hasImapPassword: boolean;
  updatedAt: Date | null;
}

export interface UpsertEmailConfigInput {
  enabled: boolean;
  fromName: string | null;
  fromEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  /** undefined/'' — не менять; непустая строка — установить. */
  smtpPassword?: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  imapUser: string | null;
  imapPassword?: string | null;
}

/** Транспорт для отправки через ящик tenant'а (с расшифрованным паролем). Internal. */
export interface SmtpTransportConfig {
  enabled: boolean;
  from: string | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  password: string | null;
}

export interface EmailMessageDto {
  id: string;
  direction: 'out' | 'in';
  status: 'sent' | 'skipped' | 'failed' | 'received';
  to: string | null;
  from: string | null;
  subject: string | null;
  messageId: string | null;
  threadId: string | null;
  relatedTicketId: string | null;
  relatedClientId: string | null;
  attachmentName: string | null;
  attachmentKind: string | null;
  isRead: boolean;
  isSpam: boolean;
  hasAttachments: boolean;
  error: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
}

const PAGE_SIZE_DEFAULT = 25;

/** Конфиг ящика без секретов (для UI). Пароли — только флагом hasPassword. */
export async function getConfig(db: Db, tenantId: string): Promise<EmailConfigDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        enabled: emailConfigs.enabled,
        fromName: emailConfigs.fromName,
        fromEmail: emailConfigs.fromEmail,
        smtpHost: emailConfigs.smtpHost,
        smtpPort: emailConfigs.smtpPort,
        smtpSecure: emailConfigs.smtpSecure,
        smtpUser: emailConfigs.smtpUser,
        hasSmtpPassword: sql<boolean>`${emailConfigs.smtpPasswordEnc} IS NOT NULL`.as('has_smtp_pw'),
        imapHost: emailConfigs.imapHost,
        imapPort: emailConfigs.imapPort,
        imapSecure: emailConfigs.imapSecure,
        imapUser: emailConfigs.imapUser,
        hasImapPassword: sql<boolean>`${emailConfigs.imapPasswordEnc} IS NOT NULL`.as('has_imap_pw'),
        updatedAt: emailConfigs.updatedAt,
      })
      .from(emailConfigs)
      .where(eq(emailConfigs.tenantId, tenantId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      enabled: r.enabled,
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      smtpHost: r.smtpHost,
      smtpPort: r.smtpPort,
      smtpSecure: r.smtpSecure,
      smtpUser: r.smtpUser,
      hasSmtpPassword: Boolean(r.hasSmtpPassword),
      imapHost: r.imapHost,
      imapPort: r.imapPort,
      imapSecure: r.imapSecure,
      imapUser: r.imapUser,
      hasImapPassword: Boolean(r.hasImapPassword),
      updatedAt: r.updatedAt,
    };
  });
}

/** Транспорт с расшифрованным паролем — только для отправки (не отдавать наружу). */
export async function getTransportConfig(
  db: Db,
  tenantId: string,
  key: string,
): Promise<SmtpTransportConfig | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        enabled: emailConfigs.enabled,
        fromName: emailConfigs.fromName,
        fromEmail: emailConfigs.fromEmail,
        smtpHost: emailConfigs.smtpHost,
        smtpPort: emailConfigs.smtpPort,
        smtpSecure: emailConfigs.smtpSecure,
        smtpUser: emailConfigs.smtpUser,
        password: decryptSql(emailConfigs.smtpPasswordEnc, key).as('smtp_pw_dec'),
      })
      .from(emailConfigs)
      .where(eq(emailConfigs.tenantId, tenantId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    const from =
      r.fromName && r.fromEmail
        ? `${r.fromName} <${r.fromEmail}>`
        : (r.fromEmail ?? null);
    return {
      enabled: r.enabled,
      from,
      host: r.smtpHost,
      port: r.smtpPort,
      secure: r.smtpSecure,
      user: r.smtpUser,
      password: (r.password as string | null) ?? null,
    };
  });
}

/** Upsert конфига. Пароли обновляются только если переданы (COALESCE с существующим). */
export async function upsertConfig(
  db: Db,
  tenantId: string,
  key: string,
  input: UpsertEmailConfigInput,
): Promise<void> {
  const encPw = (v: string | null | undefined) =>
    v ? sql`pgp_sym_encrypt(${v}::text, ${key})` : sql`NULL`;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO email_configs (
        tenant_id, enabled, from_name, from_email,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_encrypted,
        imap_host, imap_port, imap_secure, imap_user, imap_password_encrypted,
        updated_at
      ) VALUES (
        ${tenantId}, ${input.enabled}, ${input.fromName ?? null}, ${input.fromEmail ?? null},
        ${input.smtpHost ?? null}, ${input.smtpPort ?? null}, ${input.smtpSecure}, ${input.smtpUser ?? null}, ${encPw(input.smtpPassword)},
        ${input.imapHost ?? null}, ${input.imapPort ?? null}, ${input.imapSecure}, ${input.imapUser ?? null}, ${encPw(input.imapPassword)},
        now()
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        from_name = EXCLUDED.from_name,
        from_email = EXCLUDED.from_email,
        smtp_host = EXCLUDED.smtp_host,
        smtp_port = EXCLUDED.smtp_port,
        smtp_secure = EXCLUDED.smtp_secure,
        smtp_user = EXCLUDED.smtp_user,
        smtp_password_encrypted = COALESCE(EXCLUDED.smtp_password_encrypted, email_configs.smtp_password_encrypted),
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        imap_secure = EXCLUDED.imap_secure,
        imap_user = EXCLUDED.imap_user,
        imap_password_encrypted = COALESCE(EXCLUDED.imap_password_encrypted, email_configs.imap_password_encrypted),
        updated_at = now()
    `);
  });
}

/** Журнал писем. Поиск (по теме/адресу) — по расшифрованным значениям (seq scan, объём мал). */
export async function listMessages(
  db: Db,
  tenantId: string,
  key: string,
  opts: {
    page?: number;
    pageSize?: number;
    search?: string;
    direction?: 'out' | 'in';
    spam?: boolean;
  } = {},
): Promise<{ items: EmailMessageDto[]; total: number }> {
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? PAGE_SIZE_DEFAULT));
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (opts.direction) filters.push(eq(emailMessages.direction, opts.direction));
  // spam: undefined — без фильтра; false — только не-спам; true — только спам.
  if (opts.spam !== undefined) filters.push(eq(emailMessages.isSpam, opts.spam));
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      sql`(${decryptSql(emailMessages.subjectEnc, key)} ILIKE ${q} OR ${decryptSql(emailMessages.toAddrEnc, key)} ILIKE ${q})`,
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: emailMessages.id,
        direction: emailMessages.direction,
        status: emailMessages.status,
        to: decryptSql(emailMessages.toAddrEnc, key).as('to_dec'),
        from: decryptSql(emailMessages.fromAddrEnc, key).as('from_dec'),
        subject: decryptSql(emailMessages.subjectEnc, key).as('subject_dec'),
        messageId: emailMessages.messageId,
        threadId: emailMessages.threadId,
        relatedTicketId: emailMessages.relatedTicketId,
        relatedClientId: emailMessages.relatedClientId,
        attachmentName: emailMessages.attachmentName,
        attachmentKind: emailMessages.attachmentKind,
        isRead: sql<boolean>`${emailMessages.readAt} IS NOT NULL`.as('is_read'),
        isSpam: emailMessages.isSpam,
        hasAttachments: sql<boolean>`${emailMessages.attachmentName} IS NOT NULL`.as('has_attachments'),
        error: emailMessages.error,
        sentByUserId: emailMessages.sentByUserId,
        sentAt: emailMessages.sentAt,
        receivedAt: emailMessages.receivedAt,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(where)
      .orderBy(desc(emailMessages.createdAt))
      .limit(pageSize)
      .offset(offset);

    const totalRow = await tx.select({ value: count() }).from(emailMessages).where(where);

    return {
      items: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        status: r.status,
        to: (r.to as string | null) ?? null,
        from: (r.from as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        messageId: r.messageId,
        threadId: r.threadId,
        relatedTicketId: r.relatedTicketId,
        relatedClientId: r.relatedClientId,
        attachmentName: r.attachmentName,
        attachmentKind: r.attachmentKind,
        isRead: Boolean(r.isRead),
        isSpam: Boolean(r.isSpam),
        hasAttachments: Boolean(r.hasAttachments),
        error: r.error,
        sentByUserId: r.sentByUserId,
        sentAt: r.sentAt,
        receivedAt: r.receivedAt,
        createdAt: r.createdAt,
      })),
      total: Number(totalRow[0]?.value ?? 0),
    };
  });
}

/** Полное письмо с расшифрованным телом — для области чтения/треда. */
export interface EmailMessageFull extends EmailMessageDto {
  bodyText: string | null;
  bodyHtml: string | null;
  inReplyTo: string | null;
  references: string | null;
}

/** Проекция полного письма (тело + заголовки треда). Общая для getMessage/getThread. */
function fullSelection(key: string) {
  return {
    id: emailMessages.id,
    direction: emailMessages.direction,
    status: emailMessages.status,
    to: decryptSql(emailMessages.toAddrEnc, key).as('to_dec'),
    from: decryptSql(emailMessages.fromAddrEnc, key).as('from_dec'),
    subject: decryptSql(emailMessages.subjectEnc, key).as('subject_dec'),
    bodyText: decryptSql(emailMessages.bodyTextEnc, key).as('body_text_dec'),
    bodyHtml: decryptSql(emailMessages.bodyHtmlEnc, key).as('body_html_dec'),
    messageId: emailMessages.messageId,
    inReplyTo: emailMessages.inReplyTo,
    references: emailMessages.references,
    threadId: emailMessages.threadId,
    relatedTicketId: emailMessages.relatedTicketId,
    relatedClientId: emailMessages.relatedClientId,
    attachmentName: emailMessages.attachmentName,
    attachmentKind: emailMessages.attachmentKind,
    isRead: sql<boolean>`${emailMessages.readAt} IS NOT NULL`.as('is_read'),
    isSpam: emailMessages.isSpam,
    hasAttachments: sql<boolean>`${emailMessages.attachmentName} IS NOT NULL`.as('has_attachments'),
    error: emailMessages.error,
    sentByUserId: emailMessages.sentByUserId,
    sentAt: emailMessages.sentAt,
    receivedAt: emailMessages.receivedAt,
    createdAt: emailMessages.createdAt,
  };
}

type FullRow = {
  id: string;
  direction: 'out' | 'in';
  status: 'sent' | 'skipped' | 'failed' | 'received';
  to: unknown;
  from: unknown;
  subject: unknown;
  bodyText: unknown;
  bodyHtml: unknown;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
  relatedTicketId: string | null;
  relatedClientId: string | null;
  attachmentName: string | null;
  attachmentKind: string | null;
  isRead: unknown;
  isSpam: unknown;
  hasAttachments: unknown;
  error: string | null;
  sentByUserId: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
};

function mapFull(r: FullRow): EmailMessageFull {
  return {
    id: r.id,
    direction: r.direction,
    status: r.status,
    to: (r.to as string | null) ?? null,
    from: (r.from as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.bodyText as string | null) ?? null,
    bodyHtml: (r.bodyHtml as string | null) ?? null,
    messageId: r.messageId,
    inReplyTo: r.inReplyTo,
    references: r.references,
    threadId: r.threadId,
    relatedTicketId: r.relatedTicketId,
    relatedClientId: r.relatedClientId,
    attachmentName: r.attachmentName,
    attachmentKind: r.attachmentKind,
    isRead: Boolean(r.isRead),
    isSpam: Boolean(r.isSpam),
    hasAttachments: Boolean(r.hasAttachments),
    error: r.error,
    sentByUserId: r.sentByUserId,
    sentAt: r.sentAt,
    receivedAt: r.receivedAt,
    createdAt: r.createdAt,
  };
}

export async function getMessage(
  db: Db,
  tenantId: string,
  key: string,
  id: string,
): Promise<EmailMessageFull | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(fullSelection(key))
      .from(emailMessages)
      .where(eq(emailMessages.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return mapFull(r);
  });
}

/** Все письма треда (по thread_id), от старых к новым. Расшифрованы (как getMessage). */
export async function getThread(
  db: Db,
  tenantId: string,
  key: string,
  threadId: string,
): Promise<EmailMessageFull[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(fullSelection(key))
      .from(emailMessages)
      .where(eq(emailMessages.threadId, threadId))
      .orderBy(asc(emailMessages.createdAt));
    return rows.map((r) => mapFull(r as FullRow));
  });
}

/** Отметить письмо прочитанным (idempotent: только если ещё непрочитано). */
export async function markRead(db: Db, tenantId: string, id: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE email_messages SET read_at = now()
      WHERE id = ${id} AND read_at IS NULL
    `);
  });
}

/** Счётчик непрочитанных входящих (исключая спам). */
export async function unreadCount(db: Db, tenantId: string): Promise<number> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ value: count() })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.direction, 'in'),
          sql`${emailMessages.readAt} IS NULL`,
          eq(emailMessages.isSpam, false),
        ),
      );
    return Number(rows[0]?.value ?? 0);
  });
}

export interface EmailAttachmentRow {
  id: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Вложения письма (метаданные + ключ объекта). objectKey наружу НЕ отдаём. */
export async function listAttachments(
  db: Db,
  tenantId: string,
  messageId: string,
): Promise<EmailAttachmentRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: emailAttachments.id,
        objectKey: emailAttachments.objectKey,
        originalName: emailAttachments.originalName,
        mimeType: emailAttachments.mimeType,
        sizeBytes: emailAttachments.sizeBytes,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.messageId, messageId))
      .orderBy(asc(emailAttachments.createdAt));
    return rows.map((r) => ({
      id: r.id,
      objectKey: r.objectKey,
      originalName: r.originalName,
      mimeType: r.mimeType,
      sizeBytes: Number(r.sizeBytes),
    }));
  });
}

/** Вставка строки вложения входящего письма (сам файл — в object-storage). */
export async function insertEmailAttachment(
  db: Db,
  tenantId: string,
  input: {
    messageId: string;
    objectKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
  },
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.insert(emailAttachments).values({
      tenantId,
      messageId: input.messageId,
      objectKey: input.objectKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
  });
}
