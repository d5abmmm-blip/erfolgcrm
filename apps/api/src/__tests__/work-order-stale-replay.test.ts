/**
 * Реплей офлайн-очереди не затирает более свежую правку шапки наряда (№42).
 *
 * Сценарий: инженер в подвале правит «Диагноз», правка ложится в очередь.
 * Пока телефон без связи, наряд успевают поправить с десктопа. Связь
 * возвращается — очередь реплеит СТАРУЮ правку, и она молча перезаписывает
 * более позднюю. Проигравший даже не узнаёт.
 *
 * Лечение — снимок ЗНАЧЕНИЯ поля, каким его видел человек, когда правил
 * (`base`): сервер отклоняет правку кодом CONFLICT, если именно это поле уже
 * другое. Сторож по значению, а не по updatedAt наряда, НАМЕРЕННО:
 *   • updatedAt шапки дёргает любой пересчёт итогов (правка строк) — были бы
 *     ложные отказы на собственных правках;
 *   • две свои офлайн-правки разных полей делят один снимок времени — вторая
 *     ложно падала бы после успеха первой. Поля же независимы.
 * Без снимка (обычный живой вызов) поведение прежнее — последний пишет.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, withTenantTx, workOrders } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, updateWorkOrderHeader } from '../modules/work-orders/repository';

let erfolgId = '';
let clientId = '';

const TEST_PREFIX = 'TESTSTALE-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`)),
  );
}
beforeEach(clearTestData);

async function makeWo(): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  return wo.id;
}

async function readHeader(
  workOrderId: string,
): Promise<{ diagnosis: string | null; repairDescription: string | null }> {
  const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({
        diagnosis: workOrders.diagnosis,
        repairDescription: workOrders.repairDescription,
      })
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId)),
  );
  return row!;
}

describe('устаревший реплей шапки наряда', () => {
  it('поле уже изменили позже → CONFLICT, свежая правка не затёрта', async () => {
    const workOrderId = await makeWo();

    // Пока очередь ждала связи, диагноз поправили с десктопа.
    await updateWorkOrderHeader(getDb(), erfolgId, workOrderId, {
      diagnosis: 'свежая правка коллеги',
    });

    // Реплей: инженер правил, когда диагноз был ещё пуст.
    await expect(
      updateWorkOrderHeader(
        getDb(),
        erfolgId,
        workOrderId,
        { diagnosis: 'из очереди, устарело' },
        { base: { diagnosis: null } },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await readHeader(workOrderId)).diagnosis).toBe('свежая правка коллеги');
  });

  it('снимок совпадает с текущим значением → правка проходит', async () => {
    const workOrderId = await makeWo();
    await updateWorkOrderHeader(getDb(), erfolgId, workOrderId, { diagnosis: 'первая' });

    await updateWorkOrderHeader(
      getDb(),
      erfolgId,
      workOrderId,
      { diagnosis: 'вторая' },
      { base: { diagnosis: 'первая' } },
    );

    expect((await readHeader(workOrderId)).diagnosis).toBe('вторая');
  });

  it('поля независимы: чужая правка диагноза не блокирует моё описание работ', async () => {
    const workOrderId = await makeWo();
    // Коллега занял диагноз — updatedAt наряда изменился.
    await updateWorkOrderHeader(getDb(), erfolgId, workOrderId, { diagnosis: 'занято коллегой' });

    // Моя офлайн-правка ДРУГОГО поля со своим снимком обязана пройти.
    await updateWorkOrderHeader(
      getDb(),
      erfolgId,
      workOrderId,
      { repairDescription: 'заменил датчик' },
      { base: { repairDescription: null } },
    );

    const after = await readHeader(workOrderId);
    expect(after.repairDescription).toBe('заменил датчик');
    expect(after.diagnosis).toBe('занято коллегой');
  });
});
