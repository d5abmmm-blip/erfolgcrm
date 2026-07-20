/**
 * Поиск заявки по штрих-коду — путь сканера инженера (/m/scan).
 *
 * Сканер (`MobileScanPage.tsx`) шлёт распознанный код в `tickets.search` →
 * `searchTickets`. До этой фичи поле `tickets.barcode` в условии поиска
 * отсутствовало, поэтому сканер не находил НИ ОДНОЙ заявки, хотя у всех
 * импортированных из WinServisePro заявок штрих-код реальный (EAN-13).
 *
 * Покрытие:
 *   1. Заявка находится по своему штрих-коду (главный кейс сканера).
 *   2. Негативный контроль: чужая заявка в выдачу не попадает — доказывает,
 *      что сработал именно barcode, а не «вернулось всё подряд».
 *   3. Регистр: uppercase-штрихкод находится запросом в нижнем регистре
 *      (значит используется ruIlike, а не eq/like).
 *   4. Регресс: поиск по номеру заявки и по имени клиента продолжает работать.
 *   5. Удалённая заявка по штрих-коду не находится (isNull(deletedAt) на месте).
 *   6. Точное совпадение идёт первым, даже если частичное совпадение свежее.
 *      Сканер берёт matches[0] и молча открывает заявку — при `WSP-123` ⊂
 *      `WSP-1234` инженер иначе попадёт не туда.
 *
 * Изоляция: свои заявки по префиксу symptom, чистка в beforeEach/afterAll.
 * Штрих-код обязан быть уникален ГЛОБАЛЬНО (`tickets_barcode_unique` объявлен
 * без tenant_id), поэтому в значения подмешиваем метку времени.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, searchTickets, softDeleteTicket } from '../modules/tickets/repository';

let erfolgId = '';
let clientId = '';
let clientName = '';

const TEST_PREFIX = 'TESTBC-';
const STAMP = String(Date.now()).slice(-8);

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id, displayName: clients.displayName }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  clientName = c.displayName;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);
afterAll(clearTestData);

/**
 * Заводит заявку и проставляет ей нужный штрих-код (через API его задать
 * нельзя — `createTicketSchema` поля barcode не содержит, значение генерирует
 * сервер). Заодно двигаем receivedAt, чтобы порядок выдачи был предсказуем.
 */
async function makeTicket(
  tag: string,
  barcode: string,
  receivedAt?: Date,
): Promise<{ id: string; ticketNumber: string }> {
  const t = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}${tag}`,
  });
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .update(tickets)
      .set(receivedAt ? { barcode, receivedAt } : { barcode })
      .where(eq(tickets.id, t.id)),
  );
  return { id: t.id, ticketNumber: t.ticketNumber };
}

describe('searchTickets: поиск по штрих-коду (сканер инженера)', () => {
  it('находит заявку по её штрих-коду', async () => {
    // Формат как у импортированных заявок — EAN-13, только цифры.
    const barcode = `46${STAMP}001`;
    const { id } = await makeTicket('hit', barcode);

    const hits = await searchTickets(getDb(), erfolgId, barcode);
    expect(hits.some((h) => h.id === id)).toBe(true);
  });

  it('чужую заявку по этому коду не возвращает (сработал именно barcode)', async () => {
    const mine = `46${STAMP}002`;
    const other = `46${STAMP}003`;
    const a = await makeTicket('mine', mine);
    const b = await makeTicket('other', other);

    const hits = await searchTickets(getDb(), erfolgId, mine);
    expect(hits.some((h) => h.id === a.id)).toBe(true);
    expect(hits.some((h) => h.id === b.id)).toBe(false);
  });

  it('находит штрих-код в верхнем регистре запросом в нижнем', async () => {
    // Новые заявки получают barcode вида T<32 hex uppercase> (generateBarcode).
    const barcode = `T${STAMP}ABCDEF004`;
    const { id } = await makeTicket('case', barcode);

    const hits = await searchTickets(getDb(), erfolgId, barcode.toLowerCase());
    expect(hits.some((h) => h.id === id)).toBe(true);
  });

  it('удалённая заявка по штрих-коду не находится', async () => {
    const barcode = `46${STAMP}005`;
    const { id } = await makeTicket('deleted', barcode);

    expect((await softDeleteTicket(getDb(), erfolgId, id)).status).toBe('deleted');

    const hits = await searchTickets(getDb(), erfolgId, barcode);
    expect(hits.some((h) => h.id === id)).toBe(false);
  });

  it('точное совпадение идёт первым, даже если частичное свежее', async () => {
    // Импортированные заявки без штрих-кода получили WSP-<orderId>, поэтому
    // короткий код оказывается подстрокой длинного.
    const short = `WSP-${STAMP}`;
    const long = `WSP-${STAMP}9`;
    const older = new Date(Date.now() - 60 * 60 * 1000);
    const newer = new Date();

    const exact = await makeTicket('exact', short, older);
    const partial = await makeTicket('partial', long, newer);

    const hits = await searchTickets(getDb(), erfolgId, short);
    // Оба совпали по подстроке...
    expect(hits.some((h) => h.id === partial.id)).toBe(true);
    // ...но сканер откроет первый, и это должно быть точное совпадение.
    expect(hits[0]?.id).toBe(exact.id);
  });
});

describe('searchTickets: прежние поля поиска не сломаны', () => {
  it('находит по номеру заявки', async () => {
    const { id, ticketNumber } = await makeTicket('bynumber', `46${STAMP}006`);

    const hits = await searchTickets(getDb(), erfolgId, ticketNumber);
    expect(hits.some((h) => h.id === id)).toBe(true);
  });

  it('находит по имени клиента', async () => {
    const { id } = await makeTicket('byclient', `46${STAMP}007`);

    const hits = await searchTickets(getDb(), erfolgId, clientName);
    expect(hits.some((h) => h.id === id)).toBe(true);
  });
});
