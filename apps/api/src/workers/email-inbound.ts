/**
 * Воркер приёма входящих писем по IMAP (Этап B).
 *
 * Тик (по умолчанию каждые 5 минут): для каждого активного tenant'а с настроенным и
 * включённым IMAP — fetchInbox (забрать новые письма с ящика → во входящие).
 *
 * Расписание ставится только при EMAIL_INBOUND_ENABLED=true (на dev обычно дёргаем
 * вручную через email.fetchNow, чтобы не долбить ящик каждые 5 минут).
 */
import { getDb, tenants } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getQueue, registerWorker } from '../lib/queue';
import { fetchInbox } from '../modules/email/imap';

const QUEUE_NAME = 'email-inbound';
const REPEAT_JOB_ID = 'email-inbound:tick';
const TICK_JOB_NAME = 'tick';

interface TickPayload {
  reason: 'cron' | 'manual';
}

interface TickStats {
  tenants: number;
  fetched: number;
}

async function listActiveTenantIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants);
  return rows.filter((r) => r.status === 'active').map((r) => r.id);
}

export async function processEmailInboundTick(): Promise<TickStats> {
  const stats: TickStats = { tenants: 0, fetched: 0 };
  for (const tenantId of await listActiveTenantIds()) {
    stats.tenants++;
    try {
      const res = await fetchInbox(getDb(), tenantId);
      stats.fetched += res.fetched;
    } catch (err) {
      logger.warn({ err, tenantId }, 'email-inbound: fetch failed');
    }
  }
  logger.info(stats, 'email-inbound tick complete');
  return stats;
}

export async function enqueueEmailInboundSchedule(): Promise<void> {
  const pattern = process.env.EMAIL_INBOUND_CRON ?? '*/5 * * * *';
  await getQueue<TickPayload>(QUEUE_NAME).add(
    TICK_JOB_NAME,
    { reason: 'cron' },
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 100 },
    },
  );
  logger.info({ pattern }, 'email-inbound cron scheduled');
}

export function registerEmailInboundWorker(): void {
  registerWorker<TickPayload, TickStats>({
    name: QUEUE_NAME,
    concurrency: 1,
    processor: async () => processEmailInboundTick(),
  });
}
