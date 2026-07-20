/**
 * Архивация клиента и возврат из архива.
 *
 * Раньше архивация была необратима: `unarchive` не существовало ни в API, ни в
 * интерфейсе, а `updateClientSchema` объявлена `.strict()` и поля status не
 * содержит — вернуть клиента можно было только руками в psql на боевой базе.
 * У соседей (шаблоны, статьи БЗ, счета кассы, письма) возврат есть.
 *
 * Ключевая тонкость: `archiveClient` ставит ДВА поля — status='archived' и
 * deleted_at. Снять только status недостаточно: `deleted_at` отдельно смотрят
 * кабинет клиента (имя в шапке) и trade-in (можно ли выбрать клиента), поэтому
 * клиент вернулся бы наполовину. Тесты 2-4 стерегут именно это.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, getTenantEncryptionKey, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  archiveClient,
  createClient,
  listClients,
  searchClients,
  unarchiveClient,
} from '../modules/clients/repository';

const TEST_PREFIX = 'TESTARCH-';

let erfolgId = '';
let encKey = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  encKey = getTenantEncryptionKey({ id: erfolgId, kmsKeyId: null });
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
  });
}
afterAll(clearTestData);

async function makeClient(tag: string): Promise<{ id: string; name: string }> {
  const name = `${TEST_PREFIX}${tag}-${Date.now()}`;
  const { id } = await createClient(getDb(), erfolgId, encKey, {
    type: 'legal',
    displayName: name,
  });
  return { id, name };
}

async function readRaw(id: string) {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ status: clients.status, deletedAt: clients.deletedAt })
      .from(clients)
      .where(eq(clients.id, id)),
  );
  return row;
}

describe('архивация клиента', () => {
  it('ставит status=archived И deleted_at', async () => {
    const { id } = await makeClient('arch');
    await archiveClient(getDb(), erfolgId, id);

    const row = await readRaw(id);
    expect(row?.status).toBe('archived');
    expect(row?.deletedAt).not.toBeNull();
  });

  it('архивный пропадает из списка по умолчанию, но виден во вкладке «Архив»', async () => {
    const { id, name } = await makeClient('list');
    await archiveClient(getDb(), erfolgId, id);

    const active = await listClients(getDb(), erfolgId, { search: name });
    expect(active.items.some((c) => c.id === id)).toBe(false);

    const archived = await listClients(getDb(), erfolgId, { search: name, status: 'archived' });
    expect(archived.items.some((c) => c.id === id)).toBe(true);
  });
});

describe('возврат клиента из архива', () => {
  it('снимает ОБА поля — и status, и deleted_at', async () => {
    const { id } = await makeClient('both');
    await archiveClient(getDb(), erfolgId, id);
    await unarchiveClient(getDb(), erfolgId, id);

    const row = await readRaw(id);
    expect(row?.status).toBe('active');
    // Если забыть про deleted_at, клиент вернётся наполовину: в кабинете
    // останется без имени, в trade-in его нельзя будет выбрать.
    expect(row?.deletedAt).toBeNull();
  });

  it('после возврата клиента снова можно выбрать в заявке/счёте/договоре', async () => {
    const { id, name } = await makeClient('picker');

    // searchClients — это то, что стоит за ClientPicker во всех формах.
    expect((await searchClients(getDb(), erfolgId, name)).some((c) => c.id === id)).toBe(true);

    await archiveClient(getDb(), erfolgId, id);
    expect((await searchClients(getDb(), erfolgId, name)).some((c) => c.id === id)).toBe(false);

    await unarchiveClient(getDb(), erfolgId, id);
    expect((await searchClients(getDb(), erfolgId, name)).some((c) => c.id === id)).toBe(true);
  });

  it('возвращает клиента и в обычный список', async () => {
    const { id, name } = await makeClient('back');
    await archiveClient(getDb(), erfolgId, id);
    await unarchiveClient(getDb(), erfolgId, id);

    const active = await listClients(getDb(), erfolgId, { search: name });
    expect(active.items.some((c) => c.id === id)).toBe(true);
  });
});
