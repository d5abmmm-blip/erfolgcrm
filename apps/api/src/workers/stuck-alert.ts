/**
 * Воркер алертов о застревании заявок.
 *
 * Тик каждые 30 минут: по каждому активному tenant'у берёт доску (boardTickets),
 * выбирает «красные» (застряло ≥ порога или срыв SLA) и шлёт web-push менеджерам
 * (директор + диспетчеры). Дедуп — Redis-ключ на заявку с TTL ~3 дня, чтобы не
 * долбить одним и тем же алертом каждые 30 минут (повторный «нудж» раз в 3 дня).
 *
 * Push доставится только при включённом VAPID (иначе sendPush молча no-op).
 * Паттерн повторяемой задачи — как у calendar-reminder.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, tenants, users, withTenantTx } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';
import { getRedis } from '../lib/redis';
import { enqueuePushToUser } from '../modules/notifications';
import { BLOCKED_REASON_LABEL_RU, boardTickets } from '../modules/tickets/repository';

const QUEUE_NAME = 'stuck-alert';
const REPEAT_JOB_ID = 'stuck-alert:tick';
const TICK_JOB_NAME = 'tick';
/** Дедуп: не алертить одну заявку чаще, чем раз в 3 дня. */
const DEDUP_TTL_SECONDS = 3 * 24 * 3600;

interface TickPayload {
  reason: 'cron' | 'manual';
}

interface TickStats {
  tenants: number;
  stuck: number;
  alerted: number;
  skippedDedup: number;
}

async function listActiveTenantIds(): Promise<string[]> {
  const rows = await getDb().select({ id: tenants.id, status: tenants.status }).from(tenants);
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

async function staffUserIds(tenantId: string): Promise<string[]> {
  const rows = await withTenantTx(getDb(), tenantId, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.role, ['director', 'dispatcher']), eq(users.isActive, true))),
  );
  return rows.map((r) => r.id);
}

export async function processStuckAlertTick(): Promise<TickStats> {
  const stats: TickStats = { tenants: 0, stuck: 0, alerted: 0, skippedDedup: 0 };
  const redis = getRedis();
  const tenantIds = await listActiveTenantIds();
  for (const tenantId of tenantIds) {
    stats.tenants++;
    const cards = await boardTickets(getDb(), tenantId);
    const stuck = cards.filter((c) => c.light === 'red');
    if (stuck.length === 0) continue;
    const staff = await staffUserIds(tenantId);
    if (staff.length === 0) continue;

    for (const t of stuck) {
      stats.stuck++;
      // Дедуп: SET NX — если ключ уже есть, этот алерт недавно слали, пропускаем.
      const key = `erfolg:stuck-alert:${tenantId}:${t.id}`;
      const set = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      if (set === null) {
        stats.skippedDedup++;
        continue;
      }
      const reason = t.effectiveReason
        ? BLOCKED_REASON_LABEL_RU[t.effectiveReason]
        : 'причина не указана';
      for (const userId of staff) {
        try {
          await enqueuePushToUser({
            tenantId,
            userId,
            payload: {
              title: `Застряла заявка ${t.ticketNumber}`,
              body: `${t.assetModel ?? 'Техника'} стоит ${t.stuckDays} дн — ${reason}. Проверьте на доске.`,
              url: '/board',
              tag: `stuck-${t.id}`,
              data: { ticketId: t.id, ticketNumber: t.ticketNumber, kind: 'stuck' },
            },
          });
        } catch (err) {
          logger.warn({ err, ticketId: t.id, userId }, 'stuck-alert: push enqueue failed');
        }
      }
      stats.alerted++;
    }
  }
  if (stats.alerted > 0 || stats.skippedDedup > 0) {
    logger.info(stats, 'stuck-alert tick complete');
  }
  return stats;
}

/** Повторяемый тик каждые 30 минут. Идемпотентно (дедуп по jobId). */
export async function enqueueStuckAlertSchedule(): Promise<void> {
  if (process.env.STUCK_ALERT_ENABLED === 'false') return;
  const pattern = process.env.STUCK_ALERT_CRON ?? '*/30 * * * *';
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
  logger.info({ pattern }, 'stuck-alert cron scheduled');
}

export function registerStuckAlertWorker(): void {
  registerWorker<TickPayload, TickStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processStuckAlertTick(),
  });
}
