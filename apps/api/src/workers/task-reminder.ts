/**
 * Воркер push-напоминаний о задачах менеджеров с датой.
 *
 * Тик каждые 10 минут: для каждого активного tenant'а выбирает задачи,
 * у которых наступил remind_at (накануне даты в 09:00 пояса организации),
 * ещё не было отправки, задача не выполнена → шлёт web-push получателю
 * (исполнителю, иначе автору) → помечает reminded_at.
 *
 * Ссылка в push зависит от роли получателя: инженеру — мобилка /m/tasks,
 * менеджеру — /calendar.
 *
 * Паттерн — калька с calendar-reminder (BullMQ repeatable, дедуп по jobId).
 */
import { getDb, tenants } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';
import { enqueuePushToUser } from '../modules/notifications';
import { listDueTaskReminders, markTaskReminderSent } from '../modules/tasks';

const QUEUE_NAME = 'task-reminder';
const REPEAT_JOB_ID = 'task-reminder:tick';
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
  const rows = await db.select({ id: tenants.id, status: tenants.status }).from(tenants);
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

function reminderBody(row: { dueDate: string; dueTime: string | null }): string {
  const [y, m, d] = row.dueDate.split('-');
  return `${d}.${m}.${y}${row.dueTime ? ` в ${row.dueTime}` : ''}`;
}

export async function processTaskReminderTick(): Promise<TickStats> {
  const stats: TickStats = { tenants: 0, sent: 0, skippedNoUser: 0, failed: 0 };
  const tenantIds = await listActiveTenantIds();
  for (const tenantId of tenantIds) {
    stats.tenants++;
    const due = await listDueTaskReminders(getDb(), tenantId);
    for (const task of due) {
      if (!task.recipientUserId) {
        // Некому отправлять — помечаем, чтобы не возвращаться к задаче каждый тик.
        await markTaskReminderSent(getDb(), tenantId, task.id);
        stats.skippedNoUser++;
        continue;
      }
      try {
        await enqueuePushToUser({
          tenantId,
          userId: task.recipientUserId,
          payload: {
            title: `Завтра задача: ${task.title}`,
            body: reminderBody(task),
            url: task.recipientRole === 'engineer' ? '/m/tasks' : '/calendar',
            tag: `task-reminder-${task.id}`,
            data: { taskId: task.id },
          },
        });
        await markTaskReminderSent(getDb(), tenantId, task.id);
        stats.sent++;
      } catch (err) {
        stats.failed++;
        logger.warn({ err, taskId: task.id, tenantId }, 'task-reminder: push enqueue failed');
        // reminded_at не ставим — повторим в следующий тик.
      }
    }
  }
  if (stats.sent > 0 || stats.failed > 0 || stats.skippedNoUser > 0) {
    logger.info(stats, 'task-reminder tick complete');
  }
  return stats;
}

/** Повторяемый тик каждые 10 минут. Идемпотентно (дедуп по jobId). */
export async function enqueueTaskReminderSchedule(): Promise<void> {
  const pattern = process.env.TASK_REMINDER_CRON ?? '*/10 * * * *';
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
  logger.info({ pattern }, 'task-reminder cron scheduled');
}

export function registerTaskReminderWorker(): void {
  registerWorker<TickPayload, TickStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processTaskReminderTick(),
  });
}
