/**
 * Ночной тик по счетам (Этап 8.E).
 *
 * ⛔ РАССЫЛКА ОТКЛЮЧЕНА (решение владельца 2026-07-23: «почта автоматически ничего
 * не должна отправлять сама»). Раньше тик ещё и слал клиентам письма о просрочке.
 *
 * ⚠️ ПОЧЕМУ ТИК ВСЁ-ТАКИ ЖИВ, а не удалён целиком: кроме писем он делает нужную
 * работу — `markOverdueAsOf` переводит issued/partially_paid в overdue, когда
 * срок оплаты прошёл. От статуса «просрочен» зависят дашборд («Просроченные
 * счета»), отчёты, AI-итог месяца и кабинет клиента. Убрать тик = эти цифры
 * молча обнулятся, хотя долги никуда не денутся.
 *
 * Что делает тик сейчас (раз в день, по умолчанию 9:00):
 *   для каждого активного tenant'а — markOverdueAsOf(now), и всё.
 *
 * ENV:
 *   INVOICE_REMINDER_CRON='0 9 * * *' (каждый день в 9:00 серверного времени)
 *   (INVOICE_REMINDER_ENABLED больше не читается: флаг защищал вырезанную рассылку,
 *   а на бою заодно душил пометку просрочки — расписание теперь ставится всегда.)
 *
 * Добавление repeatable job: enqueueInvoiceReminderSchedule() — идемпотентно по jobId
 * (BullMQ сам деаплицирует repeat по pattern + jobId).
 */
import { getDb, tenants } from '@erfolg/db';
import { markOverdueAsOf } from '../modules/invoices';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';

const QUEUE_NAME = 'invoice-reminder';
const REPEAT_JOB_ID = 'invoice-reminder:tick';
const TICK_JOB_NAME = 'tick';

interface TickPayload {
  reason: 'cron' | 'manual';
}

// Здесь были cooldownHours() и dryRun() — настройки рассылки. Удалены вместе с ней:
// переменные INVOICE_REMINDER_COOLDOWN_HOURS и INVOICE_REMINDER_DRY_RUN больше ни на
// что не влияют. Cooldown ручной кнопки «Напомнить» живёт отдельно, в invoices/service.ts.

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
    // ⛔ РАССЫЛКА ОТКЛЮЧЕНА (решение владельца 2026-07-23). Здесь был цикл по
    // просроченным счетам с sendInvoiceReminder — робот сам писал клиентам.
    // Напомнить теперь можно только руками: кнопка «Напомнить» в Дебиторке
    // (invoices.sendReminder → sendReminderCmd), она использует тот же текст письма.
    // remindersSent/remindersSkipped остаются нулями — поля не убраны, чтобы не
    // ломать чтение статистики; при возврате рассылки заполнятся снова.
  }
  logger.info(
    stats,
    'invoice-reminder tick complete: только пометка просрочки, рассылка отключена',
  );
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
