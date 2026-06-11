/**
 * Воркер отправки Web Push уведомлений.
 *
 * Job payload: { tenantId, userId, payload }.
 *
 * Логика:
 *   1. listActiveForUser(tenantId, userId) → все непросроченные подписки этого юзера.
 *   2. Для каждой подписки: sendPush().
 *   3. На 410/404 (gone) → markRevoked.
 *   4. На остальные ошибки — лог + retry через BullMQ.
 *
 * Дедуп уже делается на уровне jobId (см. notifications/service.ts).
 */
import { getDb } from '@erfolg/db';
import { logger } from '../lib/logger';
import { QUEUE_NAMES, registerWorker } from '../lib/queue';
import { sendPush, type PushPayload } from '../lib/web-push';
import {
  listActiveForUser,
  markRevoked,
  touchLastSeen,
} from '../modules/notifications/repository';

export interface PushSendPayload {
  tenantId: string;
  userId: string;
  payload: PushPayload;
}

export async function processPushSend(job: PushSendPayload): Promise<void> {
  const subs = await listActiveForUser(getDb(), job.tenantId, job.userId);
  if (subs.length === 0) {
    logger.debug({ userId: job.userId }, 'push-send: no active subscriptions');
    return;
  }
  await Promise.all(
    subs.map(async (s) => {
      const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, job.payload);
      if (r.ok) {
        await touchLastSeen(getDb(), job.tenantId, s.endpoint);
        return;
      }
      if (r.gone) {
        await markRevoked(getDb(), job.tenantId, s.endpoint);
        logger.info({ userId: job.userId, statusCode: r.statusCode }, 'push subscription revoked (410/404)');
        return;
      }
      logger.warn(
        { userId: job.userId, statusCode: r.statusCode, error: r.error },
        'push send failed (will retry)',
      );
      throw new Error(`push send failed: ${r.statusCode} ${r.error}`);
    }),
  );
}

export function registerPushSendWorker(): void {
  registerWorker<PushSendPayload, void>({
    name: QUEUE_NAMES.pushSend,
    concurrency: 8,
    processor: async (job) => processPushSend(job.data),
  });
}
