/**
 * Поиск счёта по номеру ищет по ВСЕЙ базе, а не по открытой странице.
 *
 * ЧТО БЫЛО. Экран счетов держал строку поиска, но фильтровал ею уже полученные
 * 25 строк текущей страницы: `items.filter(inv => inv.invoiceNumber.includes(...))`.
 * Серверу поиск не передавался вовсе — у `listForTenant` такого параметра не было.
 * Пагинация при этом показывала ОБЩИЙ итог. Человек вводил номер счёта, лежащего
 * на третьей странице, видел пустую таблицу и «всего 120» под ней — и делал вывод,
 * что счёта в программе нет.
 *
 * Поиск нечувствителен к регистру и к пробелам по краям: номер переписывают из
 * бумаги, из письма, диктуют по телефону.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, invoices, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { listForTenant } from '../modules/invoices/repository';

const PREFIX = 'TESTINVSEARCH-';

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(invoices).where(like(invoices.invoiceNumber, `${PREFIX}%`));
  });
}
beforeEach(clearTestData);
afterAll(clearTestData);

/**
 * Счета заводим напрямую: нам нужен только их номер и статус.
 *
 * ⚠️ На счета стоит уникальность «один живой счёт на наряд»
 * (`invoices_tenant_work_order_uniq`), поэтому каждому тестовому счёту нужен
 * СВОЙ наряд — иначе вставка падает на второй строке.
 */
async function makeInvoices(numbers: string[]): Promise<void> {
  const rows = (await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.execute(sql`
      SELECT wo.id AS work_order_id, wo.ticket_id, t.client_id
        FROM work_orders wo
        JOIN tickets t ON t.id = wo.ticket_id
       WHERE wo.id NOT IN (SELECT work_order_id FROM invoices WHERE deleted_at IS NULL)
       LIMIT ${numbers.length}
    `),
  )) as unknown as Array<{ work_order_id: string; ticket_id: string; client_id: string }>;
  if (rows.length < numbers.length) {
    throw new Error(`нужно ${numbers.length} свободных нарядов, нашлось ${rows.length}`);
  }

  await withTenantTx(getDb(), erfolgId, async (tx) => {
    for (let i = 0; i < numbers.length; i++) {
      const r = rows[i]!;
      await tx.execute(sql`
        INSERT INTO invoices (tenant_id, invoice_number, client_id, ticket_id, work_order_id,
                              status, vat_rate, total_amount_kopecks, vat_amount_kopecks,
                              paid_amount_kopecks, issue_date, due_date)
        VALUES (${erfolgId}::uuid, ${numbers[i]!}, ${r.client_id}::uuid, ${r.ticket_id}::uuid,
                ${r.work_order_id}::uuid, 'issued', '5', 100000, 4762, 0,
                CURRENT_DATE, CURRENT_DATE + 14)
      `);
    }
  });
}

async function found(search: string): Promise<string[]> {
  const res = await listForTenant(getDb(), erfolgId, { search, limit: 200 });
  return res.items.map((i) => i.invoiceNumber).filter((n) => n.startsWith(PREFIX));
}

describe('поиск счёта по номеру', () => {
  it('находит счёт, который лежит далеко за первой страницей', async () => {
    await makeInvoices([`${PREFIX}0001`, `${PREFIX}0002`, `${PREFIX}0003`]);

    // Ограничение страницы маленькое — и всё равно находим по номеру.
    const res = await listForTenant(getDb(), erfolgId, { search: `${PREFIX}0003`, limit: 2 });
    expect(res.items.map((i) => i.invoiceNumber)).toEqual([`${PREFIX}0003`]);
  });

  it('итог под таблицей считается по найденному, а не по всей базе', async () => {
    await makeInvoices([`${PREFIX}0001`, `${PREFIX}0002`, `${PREFIX}0003`]);

    const all = await listForTenant(getDb(), erfolgId, { limit: 1 });
    const one = await listForTenant(getDb(), erfolgId, { search: `${PREFIX}0002`, limit: 1 });

    expect(one.total).toBe(1);
    // Иначе человек видит одну строку и «всего 120» под ней.
    expect(all.total).toBeGreaterThan(one.total);
  });

  it('регистр и пробелы по краям не мешают — номер переписывают из бумаги', async () => {
    await makeInvoices([`${PREFIX}ABC-77`]);

    expect(await found(`  ${PREFIX.toLowerCase()}abc-77 `)).toEqual([`${PREFIX}ABC-77`]);
  });

  it('часть номера тоже находит', async () => {
    await makeInvoices([`${PREFIX}0001`, `${PREFIX}0002`]);

    expect((await found('0001')).length).toBe(1);
  });

  it('поиск и фильтр статуса работают вместе, а не вместо друг друга', async () => {
    await makeInvoices([`${PREFIX}0001`, `${PREFIX}0002`]);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(invoices)
        .set({ status: 'paid' })
        .where(eq(invoices.invoiceNumber, `${PREFIX}0002`)),
    );

    const res = await listForTenant(getDb(), erfolgId, {
      search: PREFIX,
      status: 'issued',
      limit: 200,
    });
    expect(res.items.map((i) => i.invoiceNumber)).toEqual([`${PREFIX}0001`]);
  });

  it('без поиска ничего не меняется', async () => {
    await makeInvoices([`${PREFIX}0001`]);
    const res = await listForTenant(getDb(), erfolgId, { limit: 200 });
    expect(res.items.some((i) => i.invoiceNumber === `${PREFIX}0001`)).toBe(true);
  });

  it('пустой поиск не превращается в «найти пустоту»', async () => {
    await makeInvoices([`${PREFIX}0001`]);
    const res = await listForTenant(getDb(), erfolgId, { search: '   ', limit: 200 });
    expect(res.items.some((i) => i.invoiceNumber === `${PREFIX}0001`)).toBe(true);
  });
});

/** Счётчик и выдача обязаны считать одно и то же — иначе пагинация врёт. */
describe('счётчик не расходится с выдачей', () => {
  it('total равен числу подходящих строк', async () => {
    await makeInvoices([`${PREFIX}0001`, `${PREFIX}0002`, `${PREFIX}0003`]);
    const res = await listForTenant(getDb(), erfolgId, { search: PREFIX, limit: 200 });
    expect(res.total).toBe(res.items.length);
    expect(res.total).toBe(3);
  });
});

/** Страховка от опечатки в SQL: не тащим удалённые. */
describe('удалённые счета в поиск не попадают', () => {
  it('мягко удалённый счёт не находится', async () => {
    await makeInvoices([`${PREFIX}0001`]);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(invoices)
        .set({ deletedAt: new Date() })
        .where(and(eq(invoices.invoiceNumber, `${PREFIX}0001`))),
    );
    expect(await found(PREFIX)).toEqual([]);
  });
});
