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
import { logger } from '../../lib/logger';
import { getObjectStorage } from '../../lib/object-storage';
import type { RepairType, TicketPriority } from '@erfolg/shared';
import {
  finalizeMessageSend,
  findClientByEmail,
  getClientBrief,
  getConfig,
  getMessage,
  getThread,
  getTicketNumberById,
  getTransportConfig,
  linkMessageToTicket,
  listAttachments,
  listMessages,
  markRead,
  purgeMessage,
  restoreMessage,
  revertScheduledToDraft,
  softDeleteMessage,
  unreadCount,
  upsertConfig,
  upsertOutbox,
  type ClientBriefRow,
  type EmailConfigDto,
  type EmailFolder,
  type EmailMessageDto,
  type EmailMessageFull,
  type UpsertEmailConfigInput,
} from './repository';
import { fetchInbox, type FetchResult } from './imap';
import { computeThreadId, normalizeReferences } from './thread';
import {
  buildDeviceHint,
  cleanSymptomFromBody,
  draftReplyText,
  extractTicketDraftFromEmail,
  parseEmailAddress,
  stripHtmlToText,
} from './ai-draft';
import { cancelScheduledSend, enqueueScheduledSend } from '../../workers/email-scheduled';

export interface SendEmailInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  relatedTicketId?: string;
  relatedClientId?: string;
  attachment?: { filename: string; base64: string; kind?: string };
  /** Этап C — ответ в треде: Message-ID родителя и цепочка References. */
  inReplyTo?: string;
  references?: string[];
  /** Отправка из существующего черновика/запланированного — обновить ту же строку, а не плодить новую. */
  fromDraftId?: string;
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

/** Подпись компании (для подсказки в окне написания). Доступно staff — это не секрет. */
export async function getSignatureQuery(db: Db, tenant: ResolvedTenant): Promise<string | null> {
  const cfg = await getConfig(db, tenant.id);
  return cfg?.signature ?? null;
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
  // Подпись компании добавляется в конец письма (и в журнал — храним то, что реально отправлено).
  const finalText = cfg?.signature ? `${input.bodyText}\n\n${cfg.signature}` : input.bodyText;

  let status: 'sent' | 'skipped' | 'failed' = 'failed';
  let messageId: string | null = null;
  let errorMsg: string | null = null;
  try {
    const res = await sendMailVia(transport, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: finalText,
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
  const fromAddr = transport?.from ?? cfg?.from ?? null;

  if (input.fromDraftId) {
    // Отправка из черновика/запланированного: обновляем ту же строку, а не плодим новую.
    // При ошибке строку НЕ трогаем — она остаётся черновиком, можно повторить отправку.
    if (status !== 'failed') {
      try {
        await finalizeMessageSend(ctx.db, ctx.tenant.id, input.fromDraftId, {
          status,
          to: input.to,
          from: fromAddr,
          cc: input.cc ?? null,
          bcc: input.bcc ?? null,
          subject: input.subject,
          bodyText: finalText,
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
      } catch (err) {
        logger.warn({ err }, 'email: не удалось обновить черновик после отправки (письмо ушло)');
      }
    }
  } else {
    await tryJournalEmail(ctx.db, ctx.tenant.id, {
      direction: 'out',
      status,
      to: input.to,
      from: fromAddr,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      subject: input.subject,
      bodyText: finalText,
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
  }

  if (status === 'failed') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Не удалось отправить письмо: ${errorMsg ?? 'неизвестная ошибка'}`,
    });
  }
  return { status, messageId };
}

export interface SaveDraftInput {
  id?: string;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  relatedTicketId?: string | null;
  relatedClientId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
}

/** Создать/обновить черновик. Возвращает id (для последующих сохранений и отправки). */
export async function saveDraftCmd(ctx: CmdCtx, input: SaveDraftInput): Promise<{ id: string }> {
  const id = await upsertOutbox(ctx.db, ctx.tenant.id, {
    id: input.id,
    status: 'draft',
    to: input.to ?? null,
    cc: input.cc ?? null,
    bcc: input.bcc ?? null,
    subject: input.subject ?? null,
    bodyText: input.bodyText ?? null,
    relatedTicketId: input.relatedTicketId ?? null,
    relatedClientId: input.relatedClientId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: normalizeReferences(input.references ?? null),
    sentByUserId: ctx.session.userId,
  });
  return { id };
}

export interface ScheduleEmailInput extends SendEmailInput {
  scheduledAt: Date;
}

/** Запланировать отправку на будущее время. Создаёт/обновляет строку status='scheduled' + задачу. */
export async function scheduleEmailCmd(
  ctx: CmdCtx,
  input: ScheduleEmailInput,
): Promise<{ id: string; scheduledAt: Date }> {
  const now = Date.now();
  if (input.scheduledAt.getTime() <= now + 60_000) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Время отправки должно быть в будущем (хотя бы через минуту).',
    });
  }
  const id = await upsertOutbox(ctx.db, ctx.tenant.id, {
    id: input.fromDraftId,
    status: 'scheduled',
    scheduledAt: input.scheduledAt,
    to: input.to,
    cc: input.cc ?? null,
    bcc: input.bcc ?? null,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml ?? null,
    relatedTicketId: input.relatedTicketId ?? null,
    relatedClientId: input.relatedClientId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: normalizeReferences(input.references),
    sentByUserId: ctx.session.userId,
  });
  await enqueueScheduledSend(ctx.tenant.id, id, input.scheduledAt, now);
  return { id, scheduledAt: input.scheduledAt };
}

/** Отменить запланированную отправку: снять задачу и вернуть письмо в черновики. */
export async function cancelScheduleCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  await revertScheduledToDraft(ctx.db, ctx.tenant.id, id);
  await cancelScheduledSend(id);
  return { ok: true };
}

/** Отправить запланированное письмо немедленно (снять задачу, отправить ту же строку). */
export async function sendScheduledNowCmd(
  ctx: CmdCtx,
  id: string,
): Promise<{ status: 'sent' | 'skipped'; messageId: string | null }> {
  const msg = await getMessage(ctx.db, ctx.tenant.id, id);
  if (!msg || msg.status !== 'scheduled') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Письмо не запланировано.' });
  }
  await cancelScheduledSend(id);
  return sendEmailCmd(ctx, {
    to: msg.to ?? '',
    subject: msg.subject ?? '',
    bodyText: msg.bodyText ?? '',
    bodyHtml: msg.bodyHtml ?? undefined,
    relatedTicketId: msg.relatedTicketId ?? undefined,
    relatedClientId: msg.relatedClientId ?? undefined,
    inReplyTo: msg.inReplyTo ?? undefined,
    references: msg.references ? msg.references.split(' ').filter(Boolean) : undefined,
    fromDraftId: id,
  });
}

/** В корзину (мягкое удаление). Если письмо было запланировано — снимаем задачу. */
export async function trashCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  await softDeleteMessage(ctx.db, ctx.tenant.id, id);
  await cancelScheduledSend(id);
  return { ok: true };
}

/** Восстановить из корзины. Запланированному вернуть задачу (или в черновики, если срок прошёл). */
export async function restoreCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  await restoreMessage(ctx.db, ctx.tenant.id, id);
  const msg = await getMessage(ctx.db, ctx.tenant.id, id);
  if (msg?.status === 'scheduled' && msg.scheduledAt) {
    const when = new Date(msg.scheduledAt);
    if (when.getTime() > Date.now() + 60_000) {
      await enqueueScheduledSend(ctx.tenant.id, id, when, Date.now());
    } else {
      await revertScheduledToDraft(ctx.db, ctx.tenant.id, id);
    }
  }
  return { ok: true };
}

/** Удалить навсегда — только из корзины. Вложения из хранилища чистим best-effort. */
export async function purgeCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const atts = await listAttachments(ctx.db, ctx.tenant.id, id);
  const purged = await purgeMessage(ctx.db, ctx.tenant.id, id);
  if (!purged) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Удалять навсегда можно только из корзины.',
    });
  }
  await cancelScheduledSend(id);
  const storage = getObjectStorage();
  for (const a of atts) {
    try {
      await storage.remove(a.objectKey);
    } catch (err) {
      logger.warn({ err, key: a.objectKey }, 'email: purge attachment remove failed');
    }
  }
  return { ok: true };
}

/** Тестовое письмо самому себе (на адрес отправителя) — проверка реквизитов. */
export async function sendTestCmd(
  ctx: CmdCtx,
): Promise<{ status: 'sent' | 'skipped'; messageId: string | null }> {
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
  input: {
    page?: number;
    pageSize?: number;
    search?: string;
    folder?: EmailFolder;
    direction?: 'out' | 'in';
    spam?: boolean;
  },
): Promise<{ items: EmailMessageDto[]; total: number }> {
  return listMessages(db, tenant.id, input);
}

export function getMessageQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<EmailMessageFull | null> {
  return getMessage(db, tenant.id, id);
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
  const target = await getMessage(db, tenant.id, messageId);
  if (!target) return [];

  const msgs = target.threadId ? await getThread(db, tenant.id, target.threadId) : [target];

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

/* ─────────────────────────── Заявка из письма ─────────────────────────── */

/** Черновик заявки, собранный из письма (для префилла формы новой заявки). */
export interface EmailTicketDraftDto {
  emailId: string;
  from: string | null;
  subject: string | null;
  receivedAt: Date | null;
  /** Клиент, определённый детерминированно (по адресу отправителя), без ИИ. */
  client: ClientBriefRow | null;
  /** Симптом: из ИИ-разбора либо из текста письма (фолбэк). */
  symptom: string;
  /** Готовая подсказка по технике для баннера («УЗИ · Mindray DC-70 · сер. …»). */
  deviceHint: string | null;
  device: {
    manufacturer: string | null;
    model: string | null;
    deviceType: string | null;
    serialNumber: string | null;
  } | null;
  repairType: RepairType;
  priority: TicketPriority;
  /** Уже связанная заявка (номер в теме при приёме / создана ранее из письма). */
  linkedTicket: { id: string; number: string } | null;
  /** true — черновик разобрал ИИ (значит текст письма отправлялся в ИИ → плашка 152-ФЗ). */
  aiUsed: boolean;
}

/**
 * Собрать черновик заявки из письма. Клиент определяется БЕЗ ИИ (по адресу отправителя),
 * техника и симптом — через ИИ (с деградацией: симптом из текста письма, если ИИ недоступен).
 */
export async function draftTicketFromEmailQuery(
  db: Db,
  tenant: ResolvedTenant,
  emailId: string,
): Promise<EmailTicketDraftDto> {
  const msg = await getMessage(db, tenant.id, emailId);
  if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Письмо не найдено.' });

  // Клиент — детерминированно: сперва привязанный при приёме, иначе по адресу отправителя.
  let client: ClientBriefRow | null = msg.relatedClientId
    ? await getClientBrief(db, tenant.id, msg.relatedClientId)
    : null;
  if (!client) {
    const addr = parseEmailAddress(msg.from);
    if (addr) client = await findClientByEmail(db, tenant.id, addr);
  }

  // Уже связанная заявка (по номеру в теме при приёме или создана ранее из письма).
  let linkedTicket: { id: string; number: string } | null = null;
  if (msg.relatedTicketId) {
    const number = await getTicketNumberById(db, tenant.id, msg.relatedTicketId);
    if (number) linkedTicket = { id: msg.relatedTicketId, number };
  }

  const bodyForAi = (msg.bodyText && msg.bodyText.trim()) || stripHtmlToText(msg.bodyHtml);
  const extracted = bodyForAi
    ? await extractTicketDraftFromEmail(db, tenant, { subject: msg.subject, body: bodyForAi })
    : null;

  const symptom =
    (extracted?.symptom && extracted.symptom.trim()) ||
    cleanSymptomFromBody(msg.bodyText, msg.bodyHtml);

  const hasDevice =
    extracted != null &&
    Boolean(
      extracted.manufacturer || extracted.model || extracted.deviceType || extracted.serialNumber,
    );
  const device = hasDevice
    ? {
        manufacturer: extracted.manufacturer,
        model: extracted.model,
        deviceType: extracted.deviceType,
        serialNumber: extracted.serialNumber,
      }
    : null;

  return {
    emailId: msg.id,
    from: msg.from,
    subject: msg.subject,
    receivedAt: msg.receivedAt ?? msg.createdAt ?? null,
    client,
    symptom,
    deviceHint: device ? buildDeviceHint(device) : null,
    device,
    repairType: extracted?.repairType ?? 'paid',
    priority: extracted?.priority ?? 'normal',
    linkedTicket,
    aiUsed: extracted != null,
  };
}

/** ИИ-черновик ответа клиенту на его письмо (text всегда заполнен; aiUsed — сформулировал ли ИИ). */
export async function draftReplyQuery(
  db: Db,
  tenant: ResolvedTenant,
  emailId: string,
): Promise<{ text: string; aiUsed: boolean }> {
  const msg = await getMessage(db, tenant.id, emailId);
  if (!msg) throw new TRPCError({ code: 'NOT_FOUND', message: 'Письмо не найдено.' });
  const body = (msg.bodyText && msg.bodyText.trim()) || stripHtmlToText(msg.bodyHtml);
  return draftReplyText(db, tenant, { subject: msg.subject, body });
}

/** Привязать письмо к созданной из него заявке (для отметки «✓ Заявка T-…»). */
export async function linkTicketCmd(
  ctx: CmdCtx,
  input: { emailId: string; ticketId: string },
): Promise<{ ok: true }> {
  // Заявка должна принадлежать текущему tenant'у: RLS-scoped SELECT вернёт null для чужой
  // или несуществующей — так письмо нельзя привязать к заявке другого tenant'а (целостность).
  const ticketNumber = await getTicketNumberById(ctx.db, ctx.tenant.id, input.ticketId);
  if (!ticketNumber) throw new TRPCError({ code: 'NOT_FOUND', message: 'Заявка не найдена.' });
  await linkMessageToTicket(ctx.db, ctx.tenant.id, {
    messageId: input.emailId,
    ticketId: input.ticketId,
  });
  return { ok: true };
}
