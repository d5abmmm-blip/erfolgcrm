/**
 * tRPC роутер раздела «Почта» (Этап A — исходящие + журнал).
 * RBAC: настройки ящика — только директор; отправка и журнал — staff (директор + диспетчер).
 */
import { z } from 'zod';
import { directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  fetchInboxNow,
  getConfigQuery,
  getMessageQuery,
  getThreadQuery,
  listMessagesQuery,
  markReadCmd,
  sendEmailCmd,
  sendTestCmd,
  setConfigCmd,
  unreadCountQuery,
} from './service';

const configInput = z.object({
  enabled: z.boolean(),
  fromName: z.string().trim().max(200).nullable(),
  fromEmail: z.string().trim().email().max(320).nullable(),
  smtpHost: z.string().trim().max(255).nullable(),
  smtpPort: z.number().int().min(1).max(65535).nullable(),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(320).nullable(),
  /** undefined — не менять пароль; строка — установить. */
  smtpPassword: z.string().max(512).optional(),
  imapHost: z.string().trim().max(255).nullable(),
  imapPort: z.number().int().min(1).max(65535).nullable(),
  imapSecure: z.boolean(),
  imapUser: z.string().trim().max(320).nullable(),
  imapPassword: z.string().max(512).optional(),
});

const sendInput = z.object({
  to: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(512),
  bodyText: z.string().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).optional(),
  relatedTicketId: z.string().uuid().optional(),
  relatedClientId: z.string().uuid().optional(),
  attachment: z
    .object({
      filename: z.string().trim().min(1).max(255),
      // base64 без data:-префикса. Потолок ~15 МБ файла после base64-инфляции.
      base64: z.string().min(1).max(20_000_000),
      kind: z.string().trim().max(32).optional(),
    })
    .optional(),
  // Этап C — ответ в треде: Message-ID родителя + цепочка References.
  inReplyTo: z.string().max(512).optional(),
  references: z.array(z.string().max(512)).max(50).optional(),
});

const listInput = z
  .object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    search: z.string().trim().max(200).optional(),
    direction: z.enum(['out', 'in']).optional(),
    // undefined — без фильтра; false — без спама; true — только спам.
    spam: z.boolean().optional(),
  })
  .optional();

export const emailRouter = router({
  /** Реквизиты ящика без секретов (пароли — только флагом hasPassword). */
  getConfig: directorProcedure.query(({ ctx }) => getConfigQuery(ctx.db, ctx.tenant)),

  setConfig: directorProcedure
    .input(configInput)
    .mutation(({ ctx, input }) => setConfigCmd(buildCmdCtx(ctx), input)),

  /** Тестовое письмо на адрес отправителя — проверка реквизитов. */
  sendTest: directorProcedure.mutation(({ ctx }) => sendTestCmd(buildCmdCtx(ctx))),

  send: staffProcedure
    .input(sendInput)
    .mutation(({ ctx, input }) => sendEmailCmd(buildCmdCtx(ctx), input)),

  list: staffProcedure
    .input(listInput)
    .query(({ ctx, input }) => listMessagesQuery(ctx.db, ctx.tenant, input ?? {})),

  /** Одно письмо целиком (с расшифрованным телом) — для области чтения. */
  get: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getMessageQuery(ctx.db, ctx.tenant, input.id)),

  /** Весь тред письма (старые→новые) с вложениями (presigned-ссылки). */
  thread: staffProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .query(({ ctx, input }) => getThreadQuery(ctx.db, ctx.tenant, input.messageId)),

  /** Отметить письмо прочитанным. */
  markRead: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => markReadCmd(buildCmdCtx(ctx), input.id)),

  /** Счётчик непрочитанных входящих (для бейджа). */
  unreadCount: staffProcedure.query(({ ctx }) => unreadCountQuery(ctx.db, ctx.tenant)),

  /** Ручной приём входящих с ящика (IMAP). */
  fetchNow: staffProcedure.mutation(({ ctx }) => fetchInboxNow(ctx.db, ctx.tenant)),
});
