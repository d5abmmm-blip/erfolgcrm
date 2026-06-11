/**
 * Воркер ночных напоминаний о просроченных счетах (Этап 8.E).
 *
 * Шаги для одного «тика» (раз в день, по умолчанию 9:00):
 *   1. Для каждого активного tenant'а:
 *      a. markOverdueAsOf(now) — переводит issued/partially_paid в overdue,
 *         если due_date < сегодня.
 *      b. listOverdueForReminder(tenantId, cooldownHours) — выбирает overdue,
 *         по которым прошло >= cooldownHours с последнего напоминания.
 *      c. Для каждого: resolve client.email → sendMail → markReminderSent.
 *
 * ENV:
 *   INVOICE_REMINDER_COOLDOWN_HOURS=168 (7 дней между напоминаниями)
 *   INVOICE_REMINDER_CRON='0 9 * * *' (каждый день в 9:00 серверного времени)
 *   INVOICE_REMINDER_DRY_RUN=true (не шлёт реально, для отладки)
 *
 * Добавление repeatable job: enqueueInvoiceReminderSchedule() — идемпотентно по jobId
 * (BullMQ сам деаплицирует repeat по pattern + jobId).
 */
import { eq } from 'drizzle-orm';
import { clients, getDb, tenants, withTenantTx } from '@erfolg/db';
import {
  listOverdueForReminder,
  markOverdueAsOf,
  markReminderSent,
} from '../modules/invoices';
import { logger } from '../lib/logger';
import { sendMail } from '../lib/mailer';
import { getQueue, registerWorker } from '../lib/queue';

const QUEUE_NAME = 'invoice-reminder';
const REPEAT_JOB_ID = 'invoice-reminder:tick';
const TICK_JOB_NAME = 'tick';

interface TickPayload {
  reason: 'cron' | 'manual';
}

function cooldownHours(): number {
  const v = Number(process.env.INVOICE_REMINDER_COOLDOWN_HOURS ?? '168');
  return Number.isFinite(v) && v > 0 ? v : 168;
}

function dryRun(): boolean {
  return process.env.INVOICE_REMINDER_DRY_RUN === 'true';
}

function reminderSubject(invoiceNumber: string): string {
  return `Просроченный счёт № ${invoiceNumber}`;
}

function reminderText(args: {
  invoiceNumber: string;
  totalRub: string;
  paidRub: string;
  dueDate: string;
  tenantName: string;
}): string {
  return [
    `Здравствуйте.`,
    ``,
    `Напоминаем, что счёт № ${args.invoiceNumber} от ${args.tenantName} на сумму ${args.totalRub} ₽`,
    `(оплачено ${args.paidRub} ₽) просрочен. Срок оплаты — ${args.dueDate}.`,
    ``,
    `Просим оплатить в ближайшее время. Если оплата уже прошла — игнорируйте это письмо.`,
    ``,
    `С уважением,`,
    `${args.tenantName}`,
  ].join('\n');
}

function kopecksToRub(kopecks: string): string {
  const n = BigInt(kopecks);
  const rub = n / 100n;
  const cop = (n % 100n).toString().padStart(2, '0');
  return `${rub.toString()}.${cop}`;
}

interface TenantDetails {
  id: string;
  name: string;
}

async function listActiveTenants(): Promise<TenantDetails[]> {
  // tenants — control plane, без RLS. Доступно через app_runtime SELECT.
  const db = getDb();
  const rows = await db
    .select({
      id: tenants.id,
      displayName: tenants.displayName,
      legalName: tenants.legalName,
      status: tenants.status,
    })
    .from(tenants);
  return rows
    .filter((r) => r.status === 'active')
    .map((r) => ({ id: r.id, name: r.legalName ?? r.displayName }));
}

async function getClientEmail(
  tenantId: string,
  clientId: string,
): Promise<string | null> {
  return withTenantTx(getDb(), tenantId, async (tx) => {
    const rows = await tx
      .select({ email: clients.email })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows[0]?.email ?? null;
  });
}

interface TickStats {
  tenants: number;
  overdueMarked: number;
  remindersSent: number;
  remindersSkipped: number;
}

export async function processInvoiceReminderTick(): Promise<TickStats> {
  const stats: TickStats = { tenants: 0, overdueMarked: 0, remindersSent: 0, remindersSkipped: 0 };
  const tenantsList = await listActiveTenants();
  for (const tenant of tenantsList) {
    stats.tenants++;
    const marked = await markOverdueAsOf(getDb(), tenant.id, new Date());
    stats.overdueMarked += marked;
    const overdue = await listOverdueForReminder(getDb(), tenant.id, cooldownHours());
    for (const invoice of overdue) {
      const email = await getClientEmail(tenant.id, invoice.clientId);
      if (!email) {
        stats.remindersSkipped++;
        // Без email напомнить нельзя — но reminderCount тоже не трогаем,
        // чтобы как только email появится — напоминание пошло.
        continue;
      }
      try {
        const result = await sendMail({
          to: email,
          subject: reminderSubject(invoice.invoiceNumber),
          text: reminderText({
            invoiceNumber: invoice.invoiceNumber,
            totalRub: kopecksToRub(invoice.totalAmountKopecks),
            paidRub: kopecksToRub(invoice.paidAmountKopecks),
            dueDate: invoice.dueDate,
            tenantName: tenant.name,
          }),
          dryRun: dryRun(),
        });
        if (result.skipped) {
          stats.remindersSkipped++;
          continue;
        }
        await markReminderSent(getDb(), tenant.id, invoice.id);
        stats.remindersSent++;
      } catch (err) {
        logger.warn(
          { err, invoiceId: invoice.id, tenantId: tenant.id },
          'invoice-reminder: send failed',
        );
        // Ошибка отправки — не помечаем lastReminderSentAt; повторим в следующий тик.
      }
    }
  }
  logger.info(stats, 'invoice-reminder tick complete');
  return stats;
}

/**
 * Ставит cron-job, повторяющийся по INVOICE_REMINDER_CRON (default '0 9 * * *').
 * Идемпотентно: BullMQ дедуплицирует по `repeatJobKey`.
 */
export async function enqueueInvoiceReminderSchedule(): Promise<void> {
  const pattern = process.env.INVOICE_REMINDER_CRON ?? '0 9 * * *';
  await getQueue<TickPayload>(QUEUE_NAME).add(
    TICK_JOB_NAME,
    { reason: 'cron' },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern },
      removeOnComplete: { count: 30, age: 30 * 24 * 3600 },
      removeOnFail: { count: 100, age: 90 * 24 * 3600 },
    },
  );
  logger.info({ pattern }, 'invoice-reminder cron scheduled');
}

export function registerInvoiceReminderWorker(): void {
  registerWorker<TickPayload, TickStats>({
    name: QUEUE_NAME,
    concurrency: 1, // последовательно, не параллелим тенанты внутри
    processor: async () => {
      return processInvoiceReminderTick();
    },
  });
}
