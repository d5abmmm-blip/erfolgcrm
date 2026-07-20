/**
 * Воркер отложенной отправки писем.
 *
 * При планировании (email.schedule) ставится РАЗОВАЯ отложенная задача (delay = до времени T).
 * В момент T воркер берёт строку (status='scheduled'), отправляет через ящик tenant'а и
 * переводит её в 'sent'/'failed'. Идемпотентно: если строка уже не 'scheduled' (отправлена
 * вручную, отменена, удалена) — пропускаем.
 *
 * jobId = `email-scheduled-<messageId>`. ВАЖНО: BullMQ ЗАПРЕЩАЕТ ':' в custom jobId обычных
 * (не repeat) задач — кидает «Custom Id cannot contain :». Поэтому разделитель — дефис, а не
 * двоеточие (та самая гоча из памяти про ':' в jobId).
 *
 * Реконсиляция на старте: перечитываем все 'scheduled' строки и переenqueue — на случай
 * рестарта/потери Redis (иначе отложенные задачи пропали бы вместе с Redis).
 */
import { getDb, getTenantEncryptionKey, tenants, withTenantTx, type Db } from '@erfolg/db';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { getQueue, registerWorker, QUEUE_NAMES } from '../lib/queue';
import { sendMailVia, type SmtpTransport } from '../lib/mailer';
import { finalizeMessageSend, getMessage, getTransportConfig } from '../modules/email/repository';
import { computeThreadId } from '../modules/email/thread';

const QUEUE_NAME = QUEUE_NAMES.emailScheduled;

interface ScheduledPayload {
  tenantId: string;
  messageId: string;
}

function jobIdFor(messageId: string): string {
  // Дефис, НЕ двоеточие: BullMQ запрещает ':' в custom jobId обычных задач.
  return `email-scheduled-${messageId}`;
}

/** Поставить отложенную задачу отправки. delay = до времени runAt (мс, не меньше 0). */
export async function enqueueScheduledSend(
  tenantId: string,
  messageId: string,
  runAt: Date,
  nowMs: number,
): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - nowMs);
  const q = getQueue<ScheduledPayload>(QUEUE_NAME);
  // Снимаем прежнюю задачу (перепланирование): add с тем же jobId НЕ обновляет delay.
  await q.remove(jobIdFor(messageId)).catch(() => undefined);
  await q.add('send', { tenantId, messageId }, { jobId: jobIdFor(messageId), delay });
}

/** Снять отложенную задачу (отмена/«отправить сейчас»). Идемпотентно. */
export async function cancelScheduledSend(messageId: string): Promise<void> {
  const job = await getQueue<ScheduledPayload>(QUEUE_NAME).getJob(jobIdFor(messageId));
  if (job) await job.remove().catch(() => undefined);
}

/** Отправить одно запланированное письмо (вызывается воркером в момент T). */
export async function processScheduledSend(payload: ScheduledPayload): Promise<void> {
  const { tenantId, messageId } = payload;
  const db = getDb();
  const key = getTenantEncryptionKey({ id: tenantId, kmsKeyId: null });

  const msg = await getMessage(db, tenantId, messageId);
  // Идемпотентность: шлём только если письмо всё ещё запланировано.
  if (!msg || msg.status !== 'scheduled') {
    logger.info({ tenantId, messageId, status: msg?.status }, 'email-scheduled: пропуск (не scheduled)');
    return;
  }

  const cfg = await getTransportConfig(db, tenantId, key);
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

  // Подпись добавляется при фактической отправке (черновик/scheduled хранится без неё).
  const finalText = cfg?.signature ? `${msg.bodyText ?? ''}\n\n${cfg.signature}` : (msg.bodyText ?? '');

  let status: 'sent' | 'skipped' | 'failed' = 'failed';
  let sentMessageId: string | null = null;
  let errorMsg: string | null = null;
  try {
    const res = await sendMailVia(transport, {
      to: msg.to ?? '',
      cc: msg.cc ?? undefined,
      bcc: msg.bcc ?? undefined,
      subject: msg.subject ?? '',
      text: finalText,
      html: msg.bodyHtml ?? undefined,
      inReplyTo: msg.inReplyTo ?? undefined,
      references: msg.references ?? undefined,
    });
    status = res.skipped ? 'skipped' : 'sent';
    sentMessageId = res.messageId ?? null;
  } catch (err) {
    status = 'failed';
    errorMsg = (err as Error).message;
  }

  const threadId = computeThreadId(msg.inReplyTo ?? null, msg.references ?? null, sentMessageId);

  await finalizeMessageSend(db, tenantId, messageId, {
    status,
    to: msg.to,
    from: transport?.from ?? cfg?.from ?? null,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    bodyText: finalText,
    bodyHtml: msg.bodyHtml,
    messageId: sentMessageId ?? msg.messageId,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    threadId,
    relatedTicketId: msg.relatedTicketId,
    relatedClientId: msg.relatedClientId,
    error: errorMsg,
    sentByUserId: msg.sentByUserId,
    sentAt: status === 'sent' ? new Date() : null,
  });
  logger.info({ tenantId, messageId, status }, 'email-scheduled: обработано');
}

async function listActiveTenantIds(): Promise<string[]> {
  const rows = await getDb().select({ id: tenants.id, status: tenants.status }).from(tenants);
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

async function listScheduled(db: Db, tenantId: string): Promise<Array<{ id: string; scheduledAt: Date }>> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = (await tx.execute<{ id: string; scheduled_at: Date }>(sql`
      SELECT id, scheduled_at FROM email_messages
      WHERE status = 'scheduled' AND deleted_at IS NULL AND scheduled_at IS NOT NULL
    `)) as unknown as Array<{ id: string; scheduled_at: string | Date }>;
    return rows.map((r) => ({ id: r.id, scheduledAt: new Date(r.scheduled_at) }));
  });
}

/**
 * Реконсиляция на старте: переenqueue все запланированные письма (Redis мог потерять задачи).
 * Повторный add с тем же jobId идемпотентен. Просроченные (scheduledAt в прошлом) уйдут сразу.
 */
export async function reconcileScheduledSends(): Promise<void> {
  const db = getDb();
  const now = Date.now();
  let total = 0;
  for (const tenantId of await listActiveTenantIds()) {
    try {
      for (const r of await listScheduled(db, tenantId)) {
        await enqueueScheduledSend(tenantId, r.id, r.scheduledAt, now);
        total++;
      }
    } catch (err) {
      logger.warn({ err, tenantId }, 'email-scheduled: reconcile failed');
    }
  }
  if (total > 0) logger.info({ total }, 'email-scheduled: переенкью отложенных писем на старте');
}

export function registerEmailScheduledWorker(): void {
  registerWorker<ScheduledPayload, void>({
    name: QUEUE_NAME,
    concurrency: 4,
    processor: async (job) => processScheduledSend(job.data),
  });
}
