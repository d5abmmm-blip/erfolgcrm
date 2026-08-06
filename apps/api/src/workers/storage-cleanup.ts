/**
 * Воркер чистки осиротевших S3-объектов после soft-delete вложений.
 *
 * Job paуload: { tenantId, attachmentId, objectKey }.
 *
 * Логика:
 *   1. Проверяем строку через withTenantTx:
 *      - не существует / deletedAt IS NULL → пропускаем (вернули из корзины);
 *      - purgedAt IS NOT NULL → уже почищено, пропускаем.
 *   2. remove() из object-storage (idempotent: 404 OK).
 *   3. UPDATE purged_at = now().
 *
 * Тех-долг: sweeper для ситуации потери job'ов (Redis crash без persistence). Требует admin DB
 * (DATABASE_OWNER_URL), чтобы видеть строки во всех tenant'ах поверх RLS. Отложен.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { attachments, getDb, withTenantTx } from '@erfolg/db';
import { logger } from '../lib/logger';
import { getObjectStorage } from '../lib/object-storage';
import { getQueue, QUEUE_NAMES, registerWorker } from '../lib/queue';

export interface StorageCleanupPayload {
  tenantId: string;
  attachmentId: string;
  objectKey: string;
}

function purgeDelayMs(): number {
  const hours = Number(process.env.STORAGE_PURGE_DELAY_HOURS ?? '24');
  return Math.max(0, hours) * 60 * 60 * 1000;
}

/** Ставит delayed-job на физическое удаление объекта. Идемпотентно по jobId. */
export async function enqueueAttachmentPurge(payload: StorageCleanupPayload): Promise<void> {
  await getQueue<StorageCleanupPayload>(QUEUE_NAMES.storageCleanup).add('purge', payload, {
    // BullMQ запрещает ':' в custom jobId (молча отвергает job) → только дефис.
    jobId: `purge-${payload.attachmentId}`,
    delay: purgeDelayMs(),
  });
}

export async function processPurge(payload: StorageCleanupPayload): Promise<void> {
  const db = getDb();
  let shouldPurge = false;
  await withTenantTx(db, payload.tenantId, async (tx) => {
    const rows = await tx
      .select({
        deletedAt: attachments.deletedAt,
        purgedAt: attachments.purgedAt,
      })
      .from(attachments)
      .where(eq(attachments.id, payload.attachmentId))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    if (row.deletedAt === null) return;
    if (row.purgedAt !== null) return;
    shouldPurge = true;
  });
  if (!shouldPurge) {
    logger.debug(
      { attachmentId: payload.attachmentId },
      'storage-cleanup skipped (restored or already purged)',
    );
    return;
  }
  await getObjectStorage().remove(payload.objectKey);
  await withTenantTx(db, payload.tenantId, async (tx) => {
    await tx
      .update(attachments)
      .set({ purgedAt: sql`now()` })
      .where(and(eq(attachments.id, payload.attachmentId), isNull(attachments.purgedAt)));
  });
  logger.info(
    { attachmentId: payload.attachmentId, objectKey: payload.objectKey },
    'storage-cleanup purged',
  );
}

export function registerStorageCleanupWorker(): void {
  registerWorker<StorageCleanupPayload, void>({
    name: QUEUE_NAMES.storageCleanup,
    concurrency: 2,
    processor: async (job) => {
      await processPurge(job.data);
    },
  });
}
