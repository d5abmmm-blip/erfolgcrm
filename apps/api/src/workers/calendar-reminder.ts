/**
 * Воркер push-напоминаний о своих событиях календаря.
 *
 * Тик каждые 10 минут: для каждого активного tenant'а выбирает события,
 * у которых наступил remind_at (накануне в 09:00 пояса организации,
 * вычислен при создании события) и ещё не было отправки → шлёт web-push
 * создателю события → помечает reminded_at.
 *
 * Ошибка отправки не помечает reminded_at — повтор в следующий тик.
 * Событие без создателя помечается без отправки (некому слать),
 * чтобы не крутиться на нём вечно.
 *
 * Паттерн повторяемой задачи — как у invoice-reminder (BullMQ repeatable,
 * дедуп по jobId).
 */
import { getDb, tenants } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';
import { enqueuePushToUser } from '../modules/notifications';
import {
  listDueCalendarReminders,
  markCalendarReminderSent,
} from '../modules/calendar';

const QUEUE_NAME = 'calendar-reminder';
const REPEAT_JOB_ID = 'calendar-reminder:tick';
const TICK_JOB_NAME = 'tick';

interface TickPayload {
  reason: 'cron' | 'manual';
}

interface TickStats {
  tenants: number;
  sent: number;
  skippedNoUser: number;
  failed: number;
}

async function listActiveTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants);
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

function reminderBody(row: {
  eventDate: string;
  eventTime: string | null;
  notes: string | null;
}): string {
  const [y, m, d] = row.eventDate.split('-');
  const when = `${d}.${m}.${y}${row.eventTime ? ` в ${row.eventTime}` : ''}`;
  return row.notes ? `${when} · ${row.notes.slice(0, 120)}` : when;
}

export async function processCalendarReminderTick(): Promise<TickStats> {
  const stats: TickStats = { tenants: 0, sent: 0, skippedNoUser: 0, failed: 0 };
  const tenantIds = await listActiveTenantIds();
  for (const tenantId of tenantIds) {
    stats.tenants++;
    const due = await listDueCalendarReminders(getDb(), tenantId);
    for (const ev of due) {
      if (!ev.createdByUserId) {
        // Некому отправлять — помечаем, чтобы не возвращаться к событию каждый тик.
        await markCalendarReminderSent(getDb(), tenantId, ev.id);
        stats.skippedNoUser++;
        continue;
      }
      try {
        await enqueuePushToUser({
          tenantId,
          userId: ev.createdByUserId,
          payload: {
            title: `Завтра: ${ev.title}`,
            body: reminderBody(ev),
            url: '/calendar',
            tag: `calendar-reminder-${ev.id}`,
            data: { calendarEventId: ev.id },
          },
        });
        await markCalendarReminderSent(getDb(), tenantId, ev.id);
        stats.sent++;
      } catch (err) {
        stats.failed++;
        logger.warn(
          { err, calendarEventId: ev.id, tenantId },
          'calendar-reminder: push enqueue failed',
        );
        // reminded_at не ставим — повторим в следующий тик.
      }
    }
  }
  if (stats.sent > 0 || stats.failed > 0 || stats.skippedNoUser > 0) {
    logger.info(stats, 'calendar-reminder tick complete');
  }
  return stats;
}

/** Повторяемый тик каждые 10 минут. Идемпотентно (дедуп по jobId). */
export async function enqueueCalendarReminderSchedule(): Promise<void> {
  const pattern = process.env.CALENDAR_REMINDER_CRON ?? '*/10 * * * *';
  await getQueue<TickPayload>(QUEUE_NAME).add(
    TICK_JOB_NAME,
    { reason: 'cron' },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern },
      removeOnComplete: { count: 30, age: 7 * 24 * 3600 },
      removeOnFail: { count: 100, age: 30 * 24 * 3600 },
    },
  );
  logger.info({ pattern }, 'calendar-reminder cron scheduled');
}

export function registerCalendarReminderWorker(): void {
  registerWorker<TickPayload, TickStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processCalendarReminderTick(),
  });
}
