/**
 * Cross-tenant security tests for clients и contacts.
 *
 * Проверяем: даже если в SQL-запросе нет фильтра по tenant_id, RLS не пускает
 * к чужим данным. Также CHECK / cascade ведут себя как ожидается.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { clients, contacts, getDb, withTenantTx, withoutTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

describe('RLS — clients/contacts без tenant_id', () => {
  it('clients: SELECT без tenant возвращает 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(clients));
    expect(rows.length).toBe(0);
  });

  it('contacts: SELECT без tenant возвращает 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(contacts));
    expect(rows.length).toBe(0);
  });
});

describe('RLS — clients видны только своему tenant', () => {
  it('erfolg видит свои клиенты, не demo', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(clients));
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) expect(c.tenantId).toBe(erfolgId);
  });

  it('demo видит свои клиенты, не erfolg', async () => {
    const rows = await withTenantTx(getDb(), demoId, async (tx) => tx.select().from(clients));
    expect(rows.length).toBeGreaterThan(0);
    for (const c of rows) expect(c.tenantId).toBe(demoId);
  });
});

describe('RLS — атаки на чужой client_id', () => {
  it('SELECT erfolg-клиента под demo → 0 строк', async () => {
    const [erfolgClient] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(clients).where(eq(clients.displayName, 'ГБУ «Грозненская ЦРБ»')).limit(1),
    );
    expect(erfolgClient).toBeDefined();
    if (!erfolgClient) return;

    const stolen = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(clients).where(eq(clients.id, erfolgClient.id)),
    );
    expect(stolen.length).toBe(0);
  });

  it('UPDATE чужого клиента → 0 affected, имя не меняется', async () => {
    const [erfolgClient] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx
        .select()
        .from(clients)
        .where(eq(clients.displayName, 'ООО «Стом. клиника Улыбка»'))
        .limit(1),
    );
    if (!erfolgClient) throw new Error('seed missing');

    const updated = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .update(clients)
        .set({ displayName: 'PWNED' })
        .where(eq(clients.id, erfolgClient.id))
        .returning({ id: clients.id }),
    );
    expect(updated.length).toBe(0);

    const [unchanged] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select({ name: clients.displayName }).from(clients).where(eq(clients.id, erfolgClient.id)),
    );
    expect(unchanged?.name).toBe('ООО «Стом. клиника Улыбка»');
  });

  it('DELETE чужого клиента → 0 affected, запись на месте', async () => {
    const [erfolgClient] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(clients).where(eq(clients.displayName, 'ООО «Медцентр Здоровье»')).limit(1),
    );
    if (!erfolgClient) throw new Error('seed missing');

    const deleted = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.delete(clients).where(eq(clients.id, erfolgClient.id)).returning({ id: clients.id }),
    );
    expect(deleted.length).toBe(0);

    const [stillThere] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select({ id: clients.id }).from(clients).where(eq(clients.id, erfolgClient.id)),
    );
    expect(stillThere?.id).toBe(erfolgClient.id);
  });

  it('INSERT с подменой tenant_id → throws (RLS WITH CHECK)', async () => {
    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(clients).values({
          tenantId: erfolgId, // подменяем
          type: 'legal',
          displayName: 'Атакующий клиент',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('Search не утекает между tenant', () => {
  it('search clients под demo по INN из erfolg → пусто', async () => {
    const erfolgInn = '2014567890'; // ГБУ Грозненская ЦРБ
    const rows = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(clients).where(eq(clients.inn, erfolgInn)),
    );
    expect(rows.length).toBe(0);
  });
});

describe('CHECK constraint clients_subtype_legal_only', () => {
  it('individual + subtype=commercial → ошибка', async () => {
    await expect(
      withTenantTx(getDb(), erfolgId, async (tx) =>
        tx.insert(clients).values({
          tenantId: erfolgId,
          type: 'individual',
          subtype: 'commercial',
          displayName: 'Тест.Тест',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('ПДн клиента лежат открыто (шифрование снято в 0078, колонки убраны в 0081)', () => {
  it('полное ФИО читается из обычной колонки, без ключа и расшифровки', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.execute<{ full_name: string }>(sql`
        SELECT individual_full_name AS full_name
          FROM clients
         WHERE display_name = 'Иванов И.И.'
         LIMIT 1
      `),
    );
    const row = (rows as unknown as Array<{ full_name: string }>)[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.full_name).toBe('Иванов Иван Иванович');
  });
});

describe('CASCADE: contacts удаляются вместе с клиентом', () => {
  it('создание клиента + контакта → удаление клиента → контакт исчез', async () => {
    const created = await withTenantTx(getDb(), demoId, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        INSERT INTO clients (tenant_id, type, display_name)
        VALUES (${demoId}, 'legal', 'Cascade Test Co')
        RETURNING id
      `);
      const cid = (result as unknown as Array<{ id: string }>)[0]!.id;
      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO contacts (
          tenant_id, client_id, full_name, phone, position
        ) VALUES (
          ${demoId}, ${cid}, 'Контакт Тестовый', '+79990000000', 'Тестовый'
        ) RETURNING id
      `);
      return { clientId: cid, contactId: (ins as unknown as Array<{ id: string }>)[0]!.id };
    });

    await withTenantTx(getDb(), demoId, async (tx) =>
      tx.delete(clients).where(eq(clients.id, created.clientId)),
    );

    const remaining = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(contacts).where(eq(contacts.id, created.contactId)),
    );
    expect(remaining.length).toBe(0);
  });

  it('demo не может удалить контакт erfolg', async () => {
    const [erfolgContact] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(contacts).limit(1),
    );
    if (!erfolgContact) throw new Error('seed missing contact');
    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .delete(contacts)
        .where(and(eq(contacts.id, erfolgContact.id)))
        .returning({ id: contacts.id }),
    );
    expect(result.length).toBe(0);
  });
});
