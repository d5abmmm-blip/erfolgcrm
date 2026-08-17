/**
 * Счёт печатается СО СВОИМИ строками, а не с сегодняшними из наряда.
 *
 * ЧТО БЫЛО. В `InvoiceCardPage` шапка счёта собиралась из двух источников
 * одновременно, и в коде это было прямо описано как компромисс:
 *   • итог и ставка НДС — из «замороженного» снимка счёта (зафиксированы при
 *     выставлении);
 *   • детализация строк — из ЖИВОГО наряда, «best available».
 * Поправил менеджер наряд после выставления — и напечатанный счёт перестаёт
 * сходиться сам с собой: строки складываются в одну сумму, а «Всего к оплате»
 * показывает другую. Документ подписывают и отдают клиенту.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-17: замораживать и строки. Документ, который клиент
 * уже получил, задним числом не меняется; изменили наряд — выставляйте новый счёт.
 *
 * СНИМОК ПИШЕТСЯ РОВНО ТАМ, ГДЕ ОСВЕЖАЮТСЯ СУММЫ: при создании черновика и при
 * выставлении. Иначе появилось бы третье состояние — «сумма от одного момента,
 * строки от другого», то есть та же болезнь под другим именем.
 *
 * У счетов, выставленных ДО этой правки, снимка нет (NULL). Для них печать
 * по-прежнему берёт строки наряда: задним числом придумывать состав счёта мы не
 * имеем права, а ронять печать старых счетов — тем более.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { getDb, withTenantTx, workOrderLines, workOrders } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createDraft, getById, transitionToIssued } from '../modules/invoices/repository';

const PREFIX = 'TESTINVSNAP-';

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM invoices WHERE work_order_id IN
        (SELECT wo.id FROM work_orders wo
          JOIN work_order_lines wol ON wol.work_order_id = wo.id
         WHERE wol.name LIKE ${`${PREFIX}%`})
    `);
    await tx.delete(workOrderLines).where(like(workOrderLines.name, `${PREFIX}%`));
  });
}
beforeEach(clearTestData);
afterAll(clearTestData);

/** Свободный наряд (без живого счёта) с одной строкой работ на заданную сумму. */
async function makeWorkOrder(name: string, amountKopecks: bigint): Promise<string> {
  const rows = (await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.execute(sql`
      SELECT wo.id
        FROM work_orders wo
       WHERE wo.id NOT IN (SELECT work_order_id FROM invoices WHERE deleted_at IS NULL)
       LIMIT 1
    `),
  )) as unknown as Array<{ id: string }>;
  const workOrderId = rows[0]?.id;
  if (!workOrderId) throw new Error('нет свободного наряда');

  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(workOrderLines).where(eq(workOrderLines.workOrderId, workOrderId));
    await tx.insert(workOrderLines).values({
      tenantId: erfolgId,
      workOrderId,
      lineType: 'work',
      name,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: amountKopecks,
      amountKopecks,
    });
    await tx
      .update(workOrders)
      .set({ totalAmountKopecks: amountKopecks, worksAmountKopecks: amountKopecks })
      .where(eq(workOrders.id, workOrderId));
  });
  return workOrderId;
}

/** Меняет наряд ПОСЛЕ выставления счёта — то, из-за чего документ и расходился. */
async function editWorkOrderAfterwards(
  workOrderId: string,
  name: string,
  amountKopecks: bigint,
): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.insert(workOrderLines).values({
      tenantId: erfolgId,
      workOrderId,
      lineType: 'work',
      name,
      unit: 'шт',
      quantity: '1',
      unitPriceKopecks: amountKopecks,
      amountKopecks,
    });
  });
}

describe('строки счёта замораживаются вместе с суммой', () => {
  it('выставленный счёт помнит СВОИ строки, даже если наряд потом дописали', async () => {
    const woId = await makeWorkOrder(`${PREFIX}Замена платы`, 100000n);
    const draft = await createDraft(getDb(), erfolgId, { workOrderId: woId });
    const issued = await transitionToIssued(getDb(), erfolgId, draft.id);
    expect(issued).not.toBeNull();

    await editWorkOrderAfterwards(woId, `${PREFIX}Дописали позже`, 500000n);

    const after = await getById(getDb(), erfolgId, draft.id);
    const names = (after?.lines ?? []).map((l) => l.name);
    expect(names).toEqual([`${PREFIX}Замена платы`]);
    // И сумма строк сходится с итогом счёта — ради этого всё и делалось.
    const linesSum = (after?.lines ?? []).reduce((t, l) => t + Number(l.amountKopecks), 0);
    expect(String(linesSum)).toBe(after?.totalAmountKopecks);
  });

  it('снимок пишется уже при создании черновика', async () => {
    const woId = await makeWorkOrder(`${PREFIX}Диагностика`, 30000n);
    const draft = await createDraft(getDb(), erfolgId, { workOrderId: woId });

    const stored = await getById(getDb(), erfolgId, draft.id);
    expect((stored?.lines ?? []).map((l) => l.name)).toEqual([`${PREFIX}Диагностика`]);
  });

  it('выставление ОСВЕЖАЕТ снимок: правки черновика в счёт попадают', async () => {
    const woId = await makeWorkOrder(`${PREFIX}Было`, 100000n);
    const draft = await createDraft(getDb(), erfolgId, { workOrderId: woId });

    // Пока счёт черновик, наряд ещё правят — это нормальная работа менеджера.
    await editWorkOrderAfterwards(woId, `${PREFIX}Добавили до выставления`, 20000n);
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(workOrders)
        .set({ totalAmountKopecks: 120000n, worksAmountKopecks: 120000n })
        .where(eq(workOrders.id, woId)),
    );

    await transitionToIssued(getDb(), erfolgId, draft.id);

    const after = await getById(getDb(), erfolgId, draft.id);
    expect((after?.lines ?? []).map((l) => l.name)).toEqual([
      `${PREFIX}Было`,
      `${PREFIX}Добавили до выставления`,
    ]);
    const linesSum = (after?.lines ?? []).reduce((t, l) => t + Number(l.amountKopecks), 0);
    expect(String(linesSum)).toBe(after?.totalAmountKopecks);
  });

  it('в снимке сохраняются единицы, количество и цена — из них печатается таблица', async () => {
    const woId = await makeWorkOrder(`${PREFIX}Работа`, 100000n);
    const draft = await createDraft(getDb(), erfolgId, { workOrderId: woId });

    const line = (await getById(getDb(), erfolgId, draft.id))?.lines?.[0];
    expect(line?.unit).toBe('шт');
    expect(Number(line?.quantity)).toBe(1);
    expect(String(line?.unitPriceKopecks)).toBe('100000');
    expect(line?.lineType).toBe('work');
  });
});

describe('счета, выставленные до правки', () => {
  it('без снимка отдают lines = null, и печать возьмёт наряд, как раньше', async () => {
    const woId = await makeWorkOrder(`${PREFIX}Старый`, 100000n);
    const draft = await createDraft(getDb(), erfolgId, { workOrderId: woId });
    // Имитируем счёт, выставленный до появления колонки.
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`UPDATE invoices SET lines_snapshot = NULL WHERE id = ${draft.id}::uuid`),
    );

    const after = await getById(getDb(), erfolgId, draft.id);
    expect(after?.lines).toBeNull();
  });
});
