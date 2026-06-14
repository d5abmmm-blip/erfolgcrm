/**
 * Этап 6.B-prod — фоновая чистка осиротевших S3-объектов.
 *
 * Проверяем `processPurge` напрямую (не через BullMQ) с in-memory mock'ом ObjectStorage.
 *
 * Кейсы:
 *   1. Soft-deleted attachment → remove() вызван, purged_at проставлен.
 *   2. Восстановленный (deleted_at вернули в NULL) → remove() не вызван, purged_at NULL.
 *   3. Уже purged → remove() не вызван второй раз (idempotent).
 *   4. Несуществующий id → no-op.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  attachments,
  clients,
  getDb,
  tickets,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { insertPending, softDelete } from '../modules/attachments/repository';
import { __setObjectStorageForTesting } from '../lib/object-storage';
import type { ObjectStorage } from '../lib/object-storage';
import { processPurge } from '../workers/storage-cleanup';

let erfolgId = '';
let erfolgClientId = '';

const TEST_PREFIX = 'TEST-PURGE-';

interface MockStorage extends ObjectStorage {
  removed: string[];
}

function makeMockStorage(): MockStorage {
  const removed: string[] = [];
  return {
    removed,
    async presignPut() {
      return { url: 'mock://put', headers: {}, expiresAt: new Date(Date.now() + 60_000) };
    },
    async presignGet() {
      return { url: 'mock://get', expiresAt: new Date(Date.now() + 60_000) };
    },
    async putBuffer() {
      return undefined;
    },
    async head() {
      return null;
    },
    async remove(key) {
      removed.push(key);
    },
  };
}

let mock: MockStorage;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [ec] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!ec) throw new Error('seed missing client');
  erfolgClientId = ec.id;
});

afterAll(() => {
  __setObjectStorageForTesting(null);
});

beforeEach(async () => {
  mock = makeMockStorage();
  __setObjectStorageForTesting(mock);
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(attachments).where(like(attachments.objectKey, `tenants/%/${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

async function makeAttachment(): Promise<{ id: string; objectKey: string; ticketId: string }> {
  const ticketId = (
    await createTicket(getDb(), erfolgId, null, {
      clientId: erfolgClientId,
      symptom: `${TEST_PREFIX}t`,
    })
  ).id;
  const dto = await insertPending(getDb(), erfolgId, {
    kind: 'ticket_photo',
    referenceType: 'ticket',
    referenceId: ticketId,
    objectKey: `tenants/${erfolgId}/${TEST_PREFIX}${ticketId}-${Math.random()}.png`,
    originalName: 'p.png',
    mimeType: 'image/png',
    sizeBytes: 100n,
    userId: null,
  });
  return { id: dto.id, objectKey: dto.objectKey, ticketId };
}

describe('storage-cleanup processPurge', () => {
  it('soft-deleted attachment → remove + purged_at set', async () => {
    const a = await makeAttachment();
    const sd = await softDelete(getDb(), erfolgId, a.id);
    expect(sd?.objectKey).toBe(a.objectKey);

    await processPurge({ tenantId: erfolgId, attachmentId: a.id, objectKey: a.objectKey });

    expect(mock.removed).toEqual([a.objectKey]);

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ purgedAt: attachments.purgedAt, deletedAt: attachments.deletedAt })
        .from(attachments)
        .where(eq(attachments.id, a.id)),
    );
    expect(row?.purgedAt).not.toBeNull();
  });

  it('восстановленный attachment (deleted_at вернули в NULL) → remove() не вызывается', async () => {
    const a = await makeAttachment();
    await softDelete(getDb(), erfolgId, a.id);
    // Симулируем восстановление: возвращаем deleted_at в NULL.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(attachments).set({ deletedAt: null }).where(eq(attachments.id, a.id)),
    );

    await processPurge({ tenantId: erfolgId, attachmentId: a.id, objectKey: a.objectKey });

    expect(mock.removed).toEqual([]);
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ purgedAt: attachments.purgedAt }).from(attachments).where(eq(attachments.id, a.id)),
    );
    expect(row?.purgedAt).toBeNull();
  });

  it('уже purged_at стоит → повторный processPurge не вызывает remove()', async () => {
    const a = await makeAttachment();
    await softDelete(getDb(), erfolgId, a.id);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(attachments).set({ purgedAt: sql`now()` }).where(eq(attachments.id, a.id)),
    );

    await processPurge({ tenantId: erfolgId, attachmentId: a.id, objectKey: a.objectKey });

    expect(mock.removed).toEqual([]);
  });

  it('несуществующий id → no-op без ошибок', async () => {
    await processPurge({
      tenantId: erfolgId,
      attachmentId: '00000000-0000-0000-0000-000000000000',
      objectKey: 'tenants/x/y.png',
    });
    expect(mock.removed).toEqual([]);
  });
});
