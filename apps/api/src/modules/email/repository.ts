/**
 * Repository слой раздела «Почта». Чистые DB-функции.
 *
 * Все запросы — через withTenantTx (RLS включён на email_configs / email_messages).
 * Пароли и тело/тема/адреса — ПДн, шифруются через pgcrypto. Наружу сырой bytea не отдаём:
 * пароли — только флагом hasPassword, тело/тема/адрес — расшифрованными через decryptSql.
 */
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  clients,
  contacts,
  decryptSql,
  emailAttachments,
  emailConfigs,
  emailMessages,
  tickets,
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
  signature: string | null;
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
  signature: string | null;
}

/** Транспорт для отправки через ящик tenant'а (с расшифрованным паролем). Internal. */
export interface SmtpTransportConfig {
  enabled: boolean;
  from: string | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  signature: string | null;
  password: string | null;
}

export interface EmailMessageDto {
  id: string;
  direction: 'out' | 'in';
  status: 'sent' | 'skipped' | 'failed' | 'received' | 'draft' | 'scheduled';
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
  /** Время запланированной отправки (status='scheduled'); иначе null. */
  scheduledAt: Date | null;
  createdAt: Date;
}

const PAGE_SIZE_DEFAULT = 25;

/** Папки почтового клиента. */
export type EmailFolder = 'in' | 'out' | 'spam' | 'drafts' | 'scheduled' | 'trash';

/**
 * Предикаты «какие письма показываем в папке».
 * Корзина — только мягко-удалённые; все остальные папки — только НЕ удалённые.
 */
function folderFilters(folder: EmailFolder): SQL[] {
  if (folder === 'trash') return [sql`${emailMessages.deletedAt} IS NOT NULL`];
  const f: SQL[] = [sql`${emailMessages.deletedAt} IS NULL`];
  switch (folder) {
    case 'in':
      f.push(eq(emailMessages.direction, 'in'), eq(emailMessages.isSpam, false));
      break;
    case 'spam':
      f.push(eq(emailMessages.direction, 'in'), eq(emailMessages.isSpam, true));
      break;
    case 'out':
      f.push(
        eq(emailMessages.direction, 'out'),
        sql`${emailMessages.status} IN ('sent','skipped','failed')`,
      );
      break;
    case 'drafts':
      f.push(eq(emailMessages.status, 'draft'));
      break;
    case 'scheduled':
      f.push(eq(emailMessages.status, 'scheduled'));
      break;
  }
  return f;
}

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
        signature: emailConfigs.signature,
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
      signature: r.signature,
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
        signature: emailConfigs.signature,
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
      signature: r.signature,
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
        signature, updated_at
      ) VALUES (
        ${tenantId}, ${input.enabled}, ${input.fromName ?? null}, ${input.fromEmail ?? null},
        ${input.smtpHost ?? null}, ${input.smtpPort ?? null}, ${input.smtpSecure}, ${input.smtpUser ?? null}, ${encPw(input.smtpPassword)},
        ${input.imapHost ?? null}, ${input.imapPort ?? null}, ${input.imapSecure}, ${input.imapUser ?? null}, ${encPw(input.imapPassword)},
        ${input.signature ?? null}, now()
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
        signature = EXCLUDED.signature,
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
    folder?: EmailFolder;
    direction?: 'out' | 'in';
    spam?: boolean;
  } = {},
): Promise<{ items: EmailMessageDto[]; total: number }> {
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? PAGE_SIZE_DEFAULT));
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (opts.folder) {
    filters.push(...folderFilters(opts.folder));
  } else {
    // Обратная совместимость (вызовы без folder): только не-удалённые + старые фильтры.
    filters.push(sql`${emailMessages.deletedAt} IS NULL`);
    if (opts.direction) filters.push(eq(emailMessages.direction, opts.direction));
    // spam: undefined — без фильтра; false — только не-спам; true — только спам.
    if (opts.spam !== undefined) filters.push(eq(emailMessages.isSpam, opts.spam));
  }
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
        scheduledAt: emailMessages.scheduledAt,
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
        scheduledAt: r.scheduledAt,
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
  cc: string | null;
  bcc: string | null;
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
    cc: decryptSql(emailMessages.ccAddrEnc, key).as('cc_dec'),
    bcc: decryptSql(emailMessages.bccAddrEnc, key).as('bcc_dec'),
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
    scheduledAt: emailMessages.scheduledAt,
    createdAt: emailMessages.createdAt,
  };
}

type FullRow = {
  id: string;
  direction: 'out' | 'in';
  status: 'sent' | 'skipped' | 'failed' | 'received' | 'draft' | 'scheduled';
  to: unknown;
  from: unknown;
  subject: unknown;
  bodyText: unknown;
  bodyHtml: unknown;
  cc: unknown;
  bcc: unknown;
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
  scheduledAt: Date | null;
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
    cc: (r.cc as string | null) ?? null,
    bcc: (r.bcc as string | null) ?? null,
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
    scheduledAt: r.scheduledAt,
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

/* ───────────────────── Заявка из письма (draft) ───────────────────── */

/** Клиент для черновика заявки: id + отображаемое имя (без расшифровки ПДн). */
export interface ClientBriefRow {
  id: string;
  displayName: string;
}

/**
 * Найти активного клиента по e-mail: сперва по адресу самой организации (clients.email),
 * затем по адресу контактного лица (contacts.email). Обе колонки — B2B-контакты, plain text.
 * Регистронезависимо. RLS ограничивает поиск текущим tenant'ом.
 */
export async function findClientByEmail(
  db: Db,
  tenantId: string,
  email: string,
): Promise<ClientBriefRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const direct = await tx
      .select({ id: clients.id, displayName: clients.displayName })
      .from(clients)
      .where(and(eq(clients.status, 'active'), sql`lower(${clients.email}) = lower(${email})`))
      .limit(1);
    if (direct[0]) return direct[0];

    const viaContact = await tx
      .select({ id: clients.id, displayName: clients.displayName })
      .from(contacts)
      .innerJoin(clients, eq(contacts.clientId, clients.id))
      .where(and(eq(clients.status, 'active'), sql`lower(${contacts.email}) = lower(${email})`))
      .limit(1);
    return viaContact[0] ?? null;
  });
}

/** Отображаемое имя клиента по id (для показа уже привязанного клиента письма). */
export async function getClientBrief(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<ClientBriefRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: clients.id, displayName: clients.displayName })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Номер заявки по id (для показа связи письма с заявкой). */
export async function getTicketNumberById(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ ticketNumber: tickets.ticketNumber })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    return rows[0]?.ticketNumber ?? null;
  });
}

/**
 * Привязать письмо к заявке (и, опц., к клиенту). Возвращает true, если строка обновлена.
 * Используется после создания заявки из письма — чтобы письмо показывало «✓ Заявка T-…».
 */
export async function linkMessageToTicket(
  db: Db,
  tenantId: string,
  input: { messageId: string; ticketId: string; clientId?: string | null },
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const res = await tx
      .update(emailMessages)
      .set({
        relatedTicketId: input.ticketId,
        ...(input.clientId ? { relatedClientId: input.clientId } : {}),
      })
      .where(eq(emailMessages.id, input.messageId))
      .returning({ id: emailMessages.id });
    return res.length > 0;
  });
}

/** Поля черновика (все необязательны — черновик может быть неполным). */
export interface DraftFields {
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  relatedTicketId?: string | null;
  relatedClientId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  sentByUserId?: string | null;
}

/** Поля неотправленного исходящего: к DraftFields добавляются статус и время отправки. */
export interface OutboxFields extends DraftFields {
  status?: 'draft' | 'scheduled';
  scheduledAt?: Date | null;
}

/**
 * Создать или обновить неотправленное исходящее (черновик или запланированное), direction='out'.
 * Возвращает id. Если передан id существующей строки — обновляем (пока она draft/scheduled и не
 * в корзине); иначе (или если уже отправлена/удалена) — вставляем новую.
 */
export async function upsertOutbox(
  db: Db,
  tenantId: string,
  key: string,
  input: OutboxFields & { id?: string },
): Promise<string> {
  const enc = (v: string | null | undefined) =>
    v == null ? sql`NULL` : sql`pgp_sym_encrypt(${v}::text, ${key})`;
  const ts = (d: Date | null | undefined) =>
    d == null ? sql`NULL` : sql`${d.toISOString()}::timestamptz`;
  const status = input.status ?? 'draft';
  return withTenantTx(db, tenantId, async (tx) => {
    if (input.id) {
      const upd = (await tx.execute<{ id: string }>(sql`
        UPDATE email_messages SET
          status = ${status},
          to_addr_encrypted = ${enc(input.to)},
          cc_addr_encrypted = ${enc(input.cc)},
          bcc_addr_encrypted = ${enc(input.bcc)},
          subject_encrypted = ${enc(input.subject)},
          body_text_encrypted = ${enc(input.bodyText)},
          body_html_encrypted = ${enc(input.bodyHtml)},
          related_ticket_id = ${input.relatedTicketId ?? null},
          related_client_id = ${input.relatedClientId ?? null},
          in_reply_to = ${input.inReplyTo ?? null},
          references_list = ${input.references ?? null},
          scheduled_at = ${ts(input.scheduledAt)},
          updated_at = now()
        WHERE id = ${input.id} AND status IN ('draft','scheduled') AND deleted_at IS NULL
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      if (upd[0]?.id) return upd[0].id;
    }
    const ins = (await tx.execute<{ id: string }>(sql`
      INSERT INTO email_messages (
        tenant_id, direction, status,
        to_addr_encrypted, cc_addr_encrypted, bcc_addr_encrypted, subject_encrypted,
        body_text_encrypted, body_html_encrypted,
        related_ticket_id, related_client_id, in_reply_to, references_list, scheduled_at, sent_by_user_id
      ) VALUES (
        ${tenantId}, 'out', ${status},
        ${enc(input.to)}, ${enc(input.cc)}, ${enc(input.bcc)}, ${enc(input.subject)},
        ${enc(input.bodyText)}, ${enc(input.bodyHtml)},
        ${input.relatedTicketId ?? null}, ${input.relatedClientId ?? null},
        ${input.inReplyTo ?? null}, ${input.references ?? null}, ${ts(input.scheduledAt)}, ${input.sentByUserId ?? null}
      ) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const id = ins[0]?.id;
    if (!id) throw new Error('upsertOutbox: insert returned no id');
    return id;
  });
}

/** Вернуть запланированное письмо в черновики (отмена планирования). Только если ещё scheduled. */
export async function revertScheduledToDraft(db: Db, tenantId: string, id: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE email_messages SET status = 'draft', scheduled_at = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'scheduled' AND deleted_at IS NULL
    `);
  });
}

/** Мягкое удаление (в корзину): помечаем deleted_at. Статус не трогаем. */
export async function softDeleteMessage(db: Db, tenantId: string, id: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE email_messages SET deleted_at = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
    `);
  });
}

/** Восстановление из корзины: снимаем deleted_at. */
export async function restoreMessage(db: Db, tenantId: string, id: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE email_messages SET deleted_at = NULL, updated_at = now()
      WHERE id = ${id} AND deleted_at IS NOT NULL
    `);
  });
}

/** Полное удаление — ТОЛЬКО из корзины. Возвращает true, если строка реально удалена. */
export async function purgeMessage(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const del = (await tx.execute<{ id: string }>(sql`
      DELETE FROM email_messages WHERE id = ${id} AND deleted_at IS NOT NULL RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (!del[0]?.id) return false;
    // email_attachments без FK-cascade — чистим явно (вложения входящих в корзине).
    await tx.execute(sql`DELETE FROM email_attachments WHERE message_id = ${id}`);
    return true;
  });
}

/** Поля для перевода письма (черновик/запланированное) в финальный статус при отправке. */
export interface FinalizeSendFields {
  status: 'sent' | 'skipped' | 'failed';
  to?: string | null;
  from?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  threadId?: string | null;
  relatedTicketId?: string | null;
  relatedClientId?: string | null;
  attachmentName?: string | null;
  attachmentKind?: string | null;
  error?: string | null;
  sentByUserId?: string | null;
  sentAt?: Date | null;
}

/**
 * Перевести существующую строку (черновик/запланированное) в финальный статус
 * (sent/skipped/failed) с актуальным содержимым; scheduled_at сбрасывается в NULL.
 * Используется при отправке из черновика и воркером отложенной отправки.
 */
export async function finalizeMessageSend(
  db: Db,
  tenantId: string,
  key: string,
  id: string,
  fields: FinalizeSendFields,
): Promise<void> {
  const enc = (v: string | null | undefined) =>
    v == null ? sql`NULL` : sql`pgp_sym_encrypt(${v}::text, ${key})`;
  const ts = (d: Date | null | undefined) =>
    d == null ? sql`NULL` : sql`${d.toISOString()}::timestamptz`;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE email_messages SET
        status = ${fields.status},
        to_addr_encrypted = ${enc(fields.to)},
        from_addr_encrypted = ${enc(fields.from)},
        cc_addr_encrypted = ${enc(fields.cc)},
        bcc_addr_encrypted = ${enc(fields.bcc)},
        subject_encrypted = ${enc(fields.subject)},
        body_text_encrypted = ${enc(fields.bodyText)},
        body_html_encrypted = ${enc(fields.bodyHtml)},
        message_id = ${fields.messageId ?? null},
        in_reply_to = ${fields.inReplyTo ?? null},
        references_list = ${fields.references ?? null},
        thread_id = ${fields.threadId ?? null},
        related_ticket_id = ${fields.relatedTicketId ?? null},
        related_client_id = ${fields.relatedClientId ?? null},
        attachment_name = ${fields.attachmentName ?? null},
        attachment_kind = ${fields.attachmentKind ?? null},
        error = ${fields.error ?? null},
        sent_by_user_id = ${fields.sentByUserId ?? null},
        scheduled_at = NULL,
        sent_at = ${ts(fields.sentAt)},
        updated_at = now()
      WHERE id = ${id}
    `);
  });
}
