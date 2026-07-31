/**
 * Инвентарный номер техники в заявке — то, что видит инженер.
 *
 * Боль с боя: часть заказчиков (военные части, госбольницы) серийниками не
 * оперирует вообще — на аппарате висит только инвентарная бирка. Менеджер
 * заводит технику, заполняя ТОЛЬКО «Инвентарный №» (поле в NewTicketPage есть
 * и в БД сохраняется), а инженеру в кабинете /m/tickets/:id показывалась строка
 * «Техника: <модель> · S/N <серийник>» — серийника нет, значит опознать аппарат
 * инженеру нечем.
 *
 * Причина в API: `listTickets`/`getTicket` тянули из assets только `model` и
 * `serial_number`. Инвентарного номера в DTO не было, поэтому нарисовать его
 * на экране было физически нечем.
 *
 * Покрытие:
 *   1. getTicket отдаёт assetInventoryNumber (карточка заявки, мобильный экран).
 *   2. listTickets отдаёт assetInventoryNumber (очередь инженера, список заявок).
 *   3. Оба номера живут рядом: техника с серийником И инвентарным отдаёт оба.
 *   4. searchTickets находит заявку по инвентарному номеру — сканер/поиск
 *      инженера (/m/scan) для «инвентарных» заказчиков иначе бесполезен.
 *   5. Негативный контроль: чужая заявка по этому номеру не находится
 *      (доказывает, что сработал именно инвентарный номер, а не «вернулось всё»).
 *   6. Регресс: поиск по серийнику продолжает работать.
 *
 * Изоляция: своя техника с уникальной моделью, свои заявки по префиксу symptom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assetEvents, assets, clients, getDb, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createTicket,
  getTicket,
  listTickets,
  searchTickets,
} from '../modules/tickets/repository';
import { createAssetWithEvent } from '../modules/assets/repository';

let erfolgId = '';
let clientId = '';

const TEST_PREFIX = 'TESTINV-';
const STAMP = String(Date.now()).slice(-8);
/** Инвентарный номер «как в военной части»: только он, серийника нет. */
const INV_ONLY = `ИНВ-${STAMP}-01`;
/** Техника, у которой есть и то и другое — проверяем, что показываем оба. */
const INV_BOTH = `ИНВ-${STAMP}-02`;
const SERIAL_BOTH = `SN-${STAMP}-02`;

const createdAssetIds: string[] = [];

async function makeAsset(
  model: string,
  serialNumber: string | null,
  inventoryNumber: string | null,
): Promise<string> {
  const { id } = await createAssetWithEvent(getDb(), erfolgId, null, {
    ownerClientId: clientId,
    model,
    serialNumber,
    inventoryNumber,
  });
  createdAssetIds.push(id);
  return id;
}

async function makeTicket(tag: string, assetId: string): Promise<{ id: string }> {
  const t = await createTicket(getDb(), erfolgId, null, {
    clientId,
    assetId,
    symptom: `${TEST_PREFIX}${tag}`,
  });
  return { id: t.id };
}

let assetInvOnlyId = '';
let assetBothId = '';
let ticketInvOnlyId = '';
let ticketBothId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;

  assetInvOnlyId = await makeAsset(`${TEST_PREFIX}Дефибриллятор ${STAMP}`, null, INV_ONLY);
  assetBothId = await makeAsset(`${TEST_PREFIX}Автоклав ${STAMP}`, SERIAL_BOTH, INV_BOTH);
  ticketInvOnlyId = (await makeTicket('invonly', assetInvOnlyId)).id;
  ticketBothId = (await makeTicket('both', assetBothId)).id;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
    for (const id of createdAssetIds) {
      await tx.delete(assetEvents).where(eq(assetEvents.assetId, id));
      await tx.delete(assets).where(eq(assets.id, id));
    }
  });
});

describe('Инвентарный номер доезжает до заявки', () => {
  it('getTicket отдаёт инвентарный номер, когда серийника нет', async () => {
    const t = await getTicket(getDb(), erfolgId, ticketInvOnlyId);
    expect(t).not.toBeNull();
    expect(t!.assetSerialNumber).toBeNull();
    expect(t!.assetInventoryNumber).toBe(INV_ONLY);
  });

  it('listTickets отдаёт инвентарный номер (очередь инженера)', async () => {
    const { items } = await listTickets(getDb(), erfolgId, { clientId, pageSize: 200 });
    const row = items.find((i) => i.id === ticketInvOnlyId);
    expect(row).toBeTruthy();
    expect(row!.assetInventoryNumber).toBe(INV_ONLY);
  });

  it('когда есть оба номера — отдаём оба, а не «или-или»', async () => {
    const t = await getTicket(getDb(), erfolgId, ticketBothId);
    expect(t!.assetSerialNumber).toBe(SERIAL_BOTH);
    expect(t!.assetInventoryNumber).toBe(INV_BOTH);
  });

  it('техника без инвентарного номера отдаёт null, а не пустую строку', async () => {
    const assetId = await makeAsset(`${TEST_PREFIX}Отсасыватель ${STAMP}`, `SN-${STAMP}-03`, null);
    const { id } = await makeTicket('noinv', assetId);
    const t = await getTicket(getDb(), erfolgId, id);
    expect(t!.assetInventoryNumber).toBeNull();
  });
});

describe('searchTickets: поиск заявки по инвентарному номеру', () => {
  it('находит заявку по инвентарному номеру техники', async () => {
    const hits = await searchTickets(getDb(), erfolgId, INV_ONLY);
    expect(hits.some((h) => h.id === ticketInvOnlyId)).toBe(true);
  });

  it('чужую заявку по этому номеру не возвращает', async () => {
    const hits = await searchTickets(getDb(), erfolgId, INV_ONLY);
    expect(hits.some((h) => h.id === ticketBothId)).toBe(false);
  });

  it('поиск по серийнику не сломан', async () => {
    const hits = await searchTickets(getDb(), erfolgId, SERIAL_BOTH);
    expect(hits.some((h) => h.id === ticketBothId)).toBe(true);
  });
});
