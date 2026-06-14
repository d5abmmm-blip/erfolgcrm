/**
 * Сервис раздела «Почта». Оркестрация: загрузка реквизитов ящика → отправка → журнал.
 *
 * Отправка идёт через ящик tenant'а (email_configs). Если ящик не настроен/выключен —
 * fallback на ENV-транспорт (в dev это MailHog), чтобы локально всё работало без реквизитов.
 * Каждое письмо (успех/пропуск/ошибка) фиксируется в журнале email_messages.
 */
import { TRPCError } from '@trpc/server';
import { getTenantEncryptionKey, type Db } from '@erfolg/db';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { sendMailVia, type SmtpTransport } from '../../lib/mailer';
import { tryJournalEmail } from '../../lib/email-journal';
import { writeAudit } from '../../lib/audit';
import { getObjectStorage } from '../../lib/object-storage';
import {
  getConfig,
  getMessage,
  getThread,
  getTransportConfig,
  listAttachments,
  listMessages,
  markRead,
  unreadCount,
  upsertConfig,
  type EmailConfigDto,
  type EmailMessageDto,
  type EmailMessageFull,
  type UpsertEmailConfigInput,
} from './repository';
import { fetchInbox, type FetchResult } from './imap';
import { computeThreadId, normalizeReferences } from './thread';

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  relatedTicketId?: string;
  relatedClientId?: string;
  attachment?: { filename: string; base64: string; kind?: string };
  /** Этап C — ответ в треде: Message-ID родителя и цепочка References. */
  inReplyTo?: string;
  references?: string[];
}

/** Вложение письма для области чтения/треда (ссылка — presigned GET, не objectKey). */
export interface ThreadAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

/** Письмо треда: полное письмо + расшифрованные вложения с presigned-ссылками. */
export type ThreadMessageDto = EmailMessageFull & { attachments: ThreadAttachmentDto[] };

export function getConfigQuery(db: Db, tenant: ResolvedTenant): Promise<EmailConfigDto | null> {
  return getConfig(db, tenant.id);
}

export async function setConfigCmd(
  ctx: CmdCtx,
  input: UpsertEmailConfigInput,
): Promise<EmailConfigDto | null> {
  const key = getTenantEncryptionKey(ctx.tenant);
  await upsertConfig(ctx.db, ctx.tenant.id, key, input);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'email_config',
    entityId: ctx.tenant.id,
    ip: ctx.audit.ip,
    userAgent: ctx.audit.userAgent,
    context: {
      enabled: input.enabled,
      smtpHost: input.smtpHost,
      fromEmail: input.fromEmail,
      smtpPasswordChanged: Boolean(input.smtpPassword),
      imapPasswordChanged: Boolean(input.imapPassword),
    },
  });
  return getConfig(ctx.db, ctx.tenant.id);
}

export async function sendEmailCmd(
  ctx: CmdCtx,
  input: SendEmailInput,
): Promise<{ status: 'sent' | 'skipped'; messageId: string | null }> {
  const key = getTenantEncryptionKey(ctx.tenant);
  const cfg = await getTransportConfig(ctx.db, ctx.tenant.id, key);

  const transport: SmtpTransport | null =
    cfg && cfg.enabled && cfg.host
      ? {
          host: cfg.host,
          port: cfg.port ?? 587,
          secure: cfg.secure,
          user: cfg.user,
          pass: cfg.password,
          from: cfg.from,
        }
      : null;

  const attachments = input.attachment
    ? [
        {
          filename: input.attachment.filename,
          content: input.attachment.base64,
          contentType: 'application/pdf',
        },
      ]
    : undefined;

  const referencesStr = normalizeReferences(input.references);

  let status: 'sent' | 'skipped' | 'failed' = 'failed';
  let messageId: string | null = null;
  let errorMsg: string | null = null;
  try {
    const res = await sendMailVia(transport, {
      to: input.to,
      subject: input.subject,
      text: input.bodyText,
      html: input.bodyHtml,
      attachments,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    status = res.skipped ? 'skipped' : 'sent';
    messageId = res.messageId ?? null;
  } catch (err) {
    status = 'failed';
    errorMsg = (err as Error).message;
  }

  const threadId = computeThreadId(input.inReplyTo ?? null, referencesStr, messageId);

  await tryJournalEmail(ctx.db, ctx.tenant.id, {
    direction: 'out',
    status,
    to: input.to,
    from: transport?.from ?? cfg?.from ?? null,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml ?? null,
    messageId,
    inReplyTo: input.inReplyTo ?? null,
    references: referencesStr,
    threadId,
    relatedTicketId: input.relatedTicketId ?? null,
    relatedClientId: input.relatedClientId ?? null,
    attachmentName: input.attachment?.filename ?? null,
    attachmentKind: input.attachment?.kind ?? null,
    error: errorMsg,
    sentByUserId: ctx.session.userId,
    sentAt: status === 'sent' ? new Date() : null,
  });

  if (status === 'failed') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Не удалось отправить письмо: ${errorMsg ?? 'неизвестная ошибка'}`,
    });
  }
  return { status, messageId };
}

/** Тестовое письмо самому себе (на адрес отправителя) — проверка реквизитов. */
export async function sendTestCmd(ctx: CmdCtx): Promise<{ status: 'sent' | 'skipped'; messageId: string | null }> {
  const cfg = await getConfig(ctx.db, ctx.tenant.id);
  const to = cfg?.fromEmail;
  if (!to) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Сначала укажите адрес отправителя (From) и сохраните настройки.',
    });
  }
  return sendEmailCmd(ctx, {
    to,
    subject: 'Проверка почты ErfolgCRM',
    bodyText:
      'Это тестовое письмо из ErfolgCRM. Если вы его получили — отправка почты настроена верно.',
  });
}

export function listMessagesQuery(
  db: Db,
  tenant: ResolvedTenant,
  input: { page?: number; pageSize?: number; search?: string; direction?: 'out' | 'in'; spam?: boolean },
): Promise<{ items: EmailMessageDto[]; total: number }> {
  const key = getTenantEncryptionKey(tenant);
  return listMessages(db, tenant.id, key, input);
}

export function getMessageQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<EmailMessageFull | null> {
  const key = getTenantEncryptionKey(tenant);
  return getMessage(db, tenant.id, key, id);
}

/**
 * Весь тред письма (с вложениями) для области чтения. Если у письма есть thread_id —
 * возвращаем всю цепочку (старые→новые), иначе только само письмо. Вложения отдаём
 * presigned-ссылками; objectKey клиенту НЕ показываем.
 */
export async function getThreadQuery(
  db: Db,
  tenant: ResolvedTenant,
  messageId: string,
): Promise<ThreadMessageDto[]> {
  const key = getTenantEncryptionKey(tenant);
  const target = await getMessage(db, tenant.id, key, messageId);
  if (!target) return [];

  const msgs = target.threadId
    ? await getThread(db, tenant.id, key, target.threadId)
    : [target];

  const storage = getObjectStorage();
  return Promise.all(
    msgs.map(async (msg) => {
      const rows = await listAttachments(db, tenant.id, msg.id);
      const attachments = await Promise.all(
        rows.map(async (a) => {
          const presigned = await storage.presignGet(a.objectKey);
          return {
            id: a.id,
            name: a.originalName,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            url: presigned.url,
          };
        }),
      );
      return { ...msg, attachments };
    }),
  );
}

/** Отметить письмо прочитанным. Аудит не нужен (не ПДн-операция). */
export async function markReadCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  await markRead(ctx.db, ctx.tenant.id, id);
  return { ok: true };
}

/** Счётчик непрочитанных входящих (исключая спам) — для бейджа в меню. */
export function unreadCountQuery(db: Db, tenant: ResolvedTenant): Promise<number> {
  return unreadCount(db, tenant.id);
}

/** Ручной приём входящих (кнопка «Проверить почту»). */
export function fetchInboxNow(db: Db, tenant: ResolvedTenant): Promise<FetchResult> {
  return fetchInbox(db, tenant.id);
}
