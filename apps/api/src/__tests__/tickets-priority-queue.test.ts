/**
 * PR-3 «Приоритет двигает очередь».
 *
 * Проверяем три вещи:
 *  1. sort:'priority' — срочные наверх (urgent → high → normal → low), внутри одной
 *     срочности свежие первыми.
 *  2. priorities — фильтр «только срочные».
 *  3. РЕГРЕССИЯ: без sort порядок прежний (по дате приёма, свежие сверху) — от этого
 *     зависят карточка договора и блок «похожие случаи», их поведение менять нельзя.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { inArray, like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import type { TicketPriority } from '@erfolg/shared';
import { ensureSeed } from './setup';
import { changeStatus, createTicket, listTickets } from '../modules/tickets/repository';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';

const TEST_PREFIX = 'TEST-PRIOQ-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;

  const [c] = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;

  const usrs = await withTenantTx(getDb(), erfolgId, async (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  engineerId = usrs.find((u) => u.role === 'engineer')!.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

/** Заводит заявку с заданным приоритетом; symptom-метка изолирует тест от чужих данных. */
async function mk(priority: TicketPriority, tag: string): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}${tag}`,
    priority,
  });
  return id;
}

/** Только наши тестовые заявки (поиск по symptom-метке), в порядке выдачи. */
async function listTagged(opts: Parameters<typeof listTickets>[2] = {}) {
  const res = await listTickets(getDb(), erfolgId, {
    search: TEST_PREFIX,
    pageSize: 50,
    ...opts,
  });
  return res.items;
}

describe('Приоритет двигает очередь', () => {
  it("sort:'priority' — срочные наверх (urgent → high → normal → low)", async () => {
    // Заводим в «неправильном» порядке, чтобы дата приёма НЕ совпадала с приоритетом.
    await mk('low', 'a-low');
    await mk('urgent', 'b-urgent');
    await mk('normal', 'c-normal');
    await mk('high', 'd-high');

    const items = await listTagged({ sort: 'priority' });
    expect(items.map((t) => t.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it("sort:'priority' — внутри одной срочности свежие сверху", async () => {
    const first = await mk('urgent', 'first');
    const second = await mk('urgent', 'second'); // создан позже → должен быть выше

    const items = await listTagged({ sort: 'priority' });
    const ids = items.map((t) => t.id);
    expect(ids[0]).toBe(second);
    expect(ids[1]).toBe(first);
  });

  it("priorities:['urgent'] — фильтр «только срочные»", async () => {
    await mk('low', 'a-low');
    await mk('urgent', 'b-urgent');
    await mk('normal', 'c-normal');

    const items = await listTagged({ priorities: ['urgent'] });
    expect(items).toHaveLength(1);
    expect(items[0]!.priority).toBe('urgent');
  });

  it('фильтр можно комбинировать: несколько приоритетов', async () => {
    await mk('low', 'a-low');
    await mk('urgent', 'b-urgent');
    await mk('normal', 'c-normal');
    await mk('high', 'd-high');

    const items = await listTagged({ priorities: ['urgent', 'high'], sort: 'priority' });
    expect(items.map((t) => t.priority)).toEqual(['urgent', 'high']);
  });

  it('завершённые не обгоняют открытые: закрытая срочная НИЖЕ открытой обычной', async () => {
    // Иначе первая страница очереди со временем забилась бы закрытым архивом:
    // приоритет при закрытии не сбрасывается.
    const closedUrgent = await mk('urgent', 'a-closed-urgent');
    const openNormal = await mk('normal', 'b-open-normal');
    // Закрываем штатно (в БД есть check-констрейнт: closed без closed_at не пройдёт).
    await changeStatus(getDb(), erfolgId, null, closedUrgent, 'closed');

    const items = await listTagged({ sort: 'priority' });
    expect(items[0]!.id).toBe(openNormal); // открытая работа — выше
    expect(items[1]!.id).toBe(closedUrgent); // закрытая срочная — вниз
  });

  it('пагинация не теряет и не дублирует заявки при одинаковых приоритете и дате приёма', async () => {
    // Воспроизводим форму боевых данных: импорт проставил всему архиву priority='normal'
    // и дату БЕЗ времени → тысячи строк совпадают по (priority, received_at).
    // Без уникального последнего ключа сортировки строки «прыгают» между страницами:
    // одна попадает на две страницы, другая не попадает никуда.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await mk('normal', `tie-${String(i).padStart(2, '0')}`));
    const sameInstant = new Date('2026-03-01T10:00:00.000Z');
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.update(tickets).set({ receivedAt: sameInstant }).where(inArray(tickets.id, ids));
    });

    // Листаем постранично, как это делает UI (отдельный запрос на каждую страницу).
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await listTickets(getDb(), erfolgId, {
        search: TEST_PREFIX,
        sort: 'priority',
        page,
        pageSize: 5,
      });
      seen.push(...res.items.map((t) => t.id));
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12); // ни одного дубля
    expect([...seen].sort()).toEqual([...ids].sort()); // ни одна не потерялась
  });

  it('unassigned — только заявки без назначенного инженера (для колонок канбана)', async () => {
    // Канбан листает колонки постранично, поэтому «без назначения» обязан считаться на
    // сервере: иначе total и число страниц соврут (клиент фильтрует лишь свою страницу).
    const withEngineer = await mk('normal', 'a-assigned');
    const withoutEngineer = await mk('normal', 'b-unassigned');
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx
        .update(tickets)
        .set({ assignedEngineerId: engineerId })
        .where(inArray(tickets.id, [withEngineer]));
    });

    const res = await listTickets(getDb(), erfolgId, {
      search: TEST_PREFIX,
      unassigned: true,
      pageSize: 50,
    });
    expect(res.total).toBe(1); // total тоже честный, не только items
    expect(res.items.map((t) => t.id)).toEqual([withoutEngineer]);
  });

  it('РЕГРЕССИЯ: без sort порядок прежний — по дате приёма, свежие сверху', async () => {
    await mk('low', 'a-low');
    const urgent = await mk('urgent', 'b-urgent');
    const last = await mk('normal', 'c-normal'); // создан последним

    const items = await listTagged(); // без sort
    // Свежая заявка первая, несмотря на то что срочная была создана раньше.
    expect(items[0]!.id).toBe(last);
    expect(items[1]!.id).toBe(urgent);
    // И это НЕ порядок по приоритету:
    expect(items.map((t) => t.priority)).toEqual(['normal', 'urgent', 'low']);
  });
});
