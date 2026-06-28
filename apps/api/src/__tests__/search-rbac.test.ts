/**
 * RBAC глобального поиска (search.global → searchEverything).
 *
 * Инженеру недоступны ПДн клиентов и денежные данные (разделы «Клиенты»/«Счета»/«Договоры»
 * — staffProcedure). Поэтому глобальный поиск для роли engineer НЕ должен возвращать
 * клиентов, счета и договоры — только заявки и технику.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { searchEverything } from '../modules/search/repository';

let erfolgId = '';
const TOKEN = 'TESTSEARCHRBAC';

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(clients).where(like(clients.displayName, `${TOKEN}%`));
    await tx.insert(clients).values({
      tenantId: erfolgId,
      type: 'legal',
      displayName: `${TOKEN} Клиника`,
      inn: '7712345678',
    });
  });
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(clients).where(like(clients.displayName, `${TOKEN}%`));
  });
});

describe('глобальный поиск: RBAC по ролям', () => {
  it('директор и диспетчер видят клиентов в поиске', async () => {
    const dir = await searchEverything(getDb(), erfolgId, TOKEN, 'director');
    expect(dir.clients.length).toBeGreaterThan(0);
    const disp = await searchEverything(getDb(), erfolgId, TOKEN, 'dispatcher');
    expect(disp.clients.length).toBeGreaterThan(0);
  });

  it('инженер НЕ получает клиентов/счета/договоры', async () => {
    const eng = await searchEverything(getDb(), erfolgId, TOKEN, 'engineer');
    expect(eng.clients).toEqual([]);
    expect(eng.invoices).toEqual([]);
    expect(eng.contracts).toEqual([]);
  });
});
