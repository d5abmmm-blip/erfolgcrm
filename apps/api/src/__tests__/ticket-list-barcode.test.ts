/**
 * Список заявок отдаёт штрих-код — от этого зависит сканер БЕЗ СВЯЗИ.
 *
 * Зачем поле в списке, если оно уже есть в карточке заявки. Список
 * (`tickets.myList`) — единственное, что приложение кладёт в память телефона
 * целиком. Когда связи нет, сканер ищет заявку по нему, а на наклейке аппарата
 * напечатан именно `tickets.barcode`. Без этого поля офлайн-поиск по наклейке
 * искать нечем — то есть сканер бесполезен ровно там, где чаще всего и нужен:
 * подвал, экранированный кабинет.
 *
 * Проверка сформулирована как СВЯЗЬ двух источников: то, что список отдаёт
 * как штрих-код, должно совпадать с тем, что отдаёт карточка. Иначе тест
 * прошёл бы и на пустой строке.
 *
 * Изоляция: свои заявки по префиксу symptom, за собой удаляем.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, getTicket, listTickets } from '../modules/tickets/repository';

const TEST_PREFIX = 'TESTBARCODE-';

let erfolgId = '';
let clientId = '';
let ticketId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const t = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}скан без связи`,
  });
  ticketId = t.id;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`)),
  );
});

describe('штрих-код доезжает до списка заявок', () => {
  it('listTickets отдаёт тот же штрих-код, что и карточка заявки', async () => {
    const card = await getTicket(getDb(), erfolgId, ticketId);
    expect(card).not.toBeNull();
    // Штрих-код генерируется при создании заявки (`T` + uuid без дефисов,
    // в верхнем регистре) — пустым он быть не может.
    expect(card!.barcode).toMatch(/^T[0-9A-F]{32}$/);

    const { items } = await listTickets(getDb(), erfolgId, { clientId, pageSize: 200 });
    const row = items.find((i) => i.id === ticketId);
    expect(row).toBeTruthy();
    expect(row!.barcode).toBe(card!.barcode);
  });
});
