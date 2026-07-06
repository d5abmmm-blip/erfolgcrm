/**
 * Фича №11 «AI-итог месяца директору» — reports.monthlySummary.
 *
 * buildMonthlySummaryData собирает три готовых агрегата (касса за месяц + рентабельность
 * по closed_at + дебиторка «сейчас») в детерминированный объект БЕЗ вызова LLM.
 * renderMonthlyPrompt строит PII-free промпт.
 *
 * Изоляция: используем БУДУЩИЙ месяц (2031-04 / 2031-05) — никаких seed/чужих данных там
 * нет, поэтому tenant-wide суммы кассы и маржи за этот месяц равны РОВНО нашему вкладу.
 * Дебиторка привязана к «сейчас» (не к месяцу) → её проверяем структурно (`>=`/тип).
 * Cleanup в afterEach чистит тикеты (каскад нарядов) + активы + инженеров + кассу по префиксу.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  assets,
  cashAccounts,
  cashCategories,
  cashTransactions,
  clients,
  getDb,
  tickets,
  users,
  withTenantTx,
  workOrders,
} from '@erfolg/db';
import type { ResolvedTenant } from '../lib/tenant';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder } from '../modules/work-orders/repository';
import { createAccount, createCategory, createTransaction } from '../modules/cash/repository';
import {
  buildMonthlySummaryData,
  renderMonthlyPrompt,
  type MonthlySummaryData,
} from '../modules/reports/monthly-summary';

let erfolgId = '';
let clientId = '';
let tenant: ResolvedTenant;
let seq = 0;

const PREFIX = 'TESTMS-';
const USER_PREFIX = 'testms-eng-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  tenant = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'Эрфольг',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
});

afterEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    // Кассу — сначала операции (FK на счета), потом счета и статьи.
    await tx.delete(cashTransactions).where(like(cashTransactions.comment, `${PREFIX}%`));
    await tx.delete(cashAccounts).where(like(cashAccounts.name, `${PREFIX}%`));
    await tx.delete(cashCategories).where(like(cashCategories.name, `${PREFIX}%`));
    // Тикеты (каскад нарядов) + активы + инженеры.
    await tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`));
    await tx.delete(assets).where(like(assets.model, `${PREFIX}%`));
    await tx.delete(users).where(like(users.username, `${USER_PREFIX}%`));
  });
});

async function makeEngineer(fullName: string): Promise<string> {
  seq += 1;
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .insert(users)
      .values({
        tenantId: erfolgId,
        username: `${USER_PREFIX}${Date.now()}-${seq}`,
        fullName,
        role: 'engineer',
        passwordHash: 'x',
      })
      .returning({ id: users.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('makeEngineer: insert returned nothing');
  return row.id;
}

async function makeAsset(deviceType: string): Promise<string> {
  seq += 1;
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .insert(assets)
      .values({ tenantId: erfolgId, model: `${PREFIX}asset-${seq}`, deviceType })
      .returning({ id: assets.id }),
  );
  const row = rows[0];
  if (!row) throw new Error('makeAsset: insert returned nothing');
  return row.id;
}

/** Закрытый наряд с явной датой закрытия и материализованными суммами. */
async function makeClosedWOAt(opts: {
  closedAt: Date;
  total: bigint;
  cost: bigint;
  margin: bigint;
  engineerId: string | null;
  assetId: string | null;
}): Promise<void> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    assetId: opts.assetId ?? undefined,
    symptom: `${PREFIX}wo`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .update(workOrders)
      .set({
        totalAmountKopecks: opts.total,
        costAmountKopecks: opts.cost,
        marginAmountKopecks: opts.margin,
        engineerId: opts.engineerId,
      })
      .where(eq(workOrders.id, wo.id));
    await tx
      .update(tickets)
      .set({ status: 'closed', closedAt: opts.closedAt })
      .where(eq(tickets.id, ticketId));
  });
}

/** Денежный счёт (kind bank) с префиксом для cleanup. */
async function makeAccount(): Promise<string> {
  seq += 1;
  const acc = await createAccount(getDb(), erfolgId, {
    name: `${PREFIX}счёт-${seq}`,
    kind: 'bank',
  });
  return acc.id;
}

describe('reports.monthlySummary — AI-итог месяца (фича №11)', () => {
  it('собирает кассу, рентабельность и дебиторку за выбранный месяц', async () => {
    const accountId = await makeAccount();
    const cat = await createCategory(getDb(), erfolgId, {
      name: `${PREFIX}ЗИП`,
      direction: 'expense',
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId,
      amountKopecks: 500_000n,
      occurredOn: '2031-04-15',
      comment: `${PREFIX}income`,
      userId: null,
    });
    await createTransaction(getDb(), erfolgId, {
      kind: 'expense',
      accountId,
      categoryId: cat.id,
      amountKopecks: 200_000n,
      occurredOn: '2031-04-20',
      comment: `${PREFIX}expense`,
      userId: null,
    });

    const engId = await makeEngineer('Тест Инженер Апрель');
    const deviceType = `${PREFIX}УЗИ-${Date.now()}`;
    const assetId = await makeAsset(deviceType);
    await makeClosedWOAt({
      closedAt: new Date('2031-04-10T09:00:00Z'),
      total: 300_000n,
      cost: 100_000n,
      margin: 200_000n,
      engineerId: engId,
      assetId,
    });

    const { month, monthLabel, data } = await buildMonthlySummaryData(getDb(), tenant, '2031-04');

    expect(month).toBe('2031-04');
    expect(monthLabel).toBe('Апрель 2031');

    // Касса за месяц — ровно наш вклад (будущий месяц изолирован).
    expect(data.cash.incomeKopecks).toBe('500000');
    expect(data.cash.expenseKopecks).toBe('200000');
    expect(data.cash.profitKopecks).toBe('300000');
    expect(data.cash.topExpenses[0]?.name).toBe(`${PREFIX}ЗИП`);
    expect(data.cash.topExpenses[0]?.amountKopecks).toBe('200000');

    // Рентабельность за месяц — ровно наш закрытый наряд.
    expect(data.profit.closedOrdersCount).toBe(1);
    expect(data.profit.revenueKopecks).toBe('300000');
    expect(data.profit.marginKopecks).toBe('200000');
    expect(data.profit.marginPercent).toBeCloseTo(66.67, 1);
    expect(data.profit.topEngineer?.name).toBe('Тест Инженер Апрель');
    expect(data.profit.topEngineer?.marginKopecks).toBe('200000');
    expect(data.profit.topEquipment?.name).toBe(deviceType);

    // Дебиторка «сейчас» — структурно (tenant-wide, изолировать по месяцу нельзя).
    expect(() => BigInt(data.receivables.totalRemainingKopecks)).not.toThrow();
    expect(() => BigInt(data.receivables.overdueRemainingKopecks)).not.toThrow();
    expect(data.receivables.debtorCount).toBeGreaterThanOrEqual(0);
    expect(data.receivables.overdueInvoiceCount).toBeGreaterThanOrEqual(0);
  });

  it('границы месяца: касса и наряды из соседнего месяца не попадают', async () => {
    const accountId = await makeAccount();
    // Всё — в МАЕ 2031.
    await createTransaction(getDb(), erfolgId, {
      kind: 'income',
      accountId,
      amountKopecks: 777_000n,
      occurredOn: '2031-05-02',
      comment: `${PREFIX}income`,
      userId: null,
    });
    await makeClosedWOAt({
      closedAt: new Date('2031-05-05T09:00:00Z'),
      total: 400_000n,
      cost: 100_000n,
      margin: 300_000n,
      engineerId: null,
      assetId: null,
    });

    // Апрель — пусто (будущий изолированный месяц без данных).
    const april = await buildMonthlySummaryData(getDb(), tenant, '2031-04');
    expect(april.data.cash.incomeKopecks).toBe('0');
    expect(april.data.profit.closedOrdersCount).toBe(0);
    expect(april.data.profit.revenueKopecks).toBe('0');

    // Май — наши данные на месте.
    const may = await buildMonthlySummaryData(getDb(), tenant, '2031-05');
    expect(may.monthLabel).toBe('Май 2031');
    expect(may.data.cash.incomeKopecks).toBe('777000');
    expect(may.data.profit.closedOrdersCount).toBe(1);
    expect(may.data.profit.marginKopecks).toBe('300000');
  });

  it('renderMonthlyPrompt: только агрегаты, форматирование сумм, без ПДн клиента', () => {
    const data: MonthlySummaryData = {
      cash: {
        incomeKopecks: '118000000',
        expenseKopecks: '69000000',
        profitKopecks: '49000000',
        topExpenses: [{ name: 'Закупка ЗИП', amountKopecks: '32000000' }],
        balanceTotalKopecks: '146000000',
        balanceCashKopecks: '8500000',
        balanceNonCashKopecks: '137500000',
      },
      profit: {
        closedOrdersCount: 38,
        revenueKopecks: '124000000',
        costKopecks: '72800000',
        marginKopecks: '51200000',
        marginPercent: 41.29,
        topEngineer: { name: 'Алероев', marginKopecks: '16800000' },
        topEquipment: { name: 'УЗИ', marginKopecks: '20000000' },
      },
      receivables: {
        totalRemainingKopecks: '43000000',
        overdueRemainingKopecks: '21000000',
        debtorCount: 4,
        overdueInvoiceCount: 6,
      },
    };

    const prompt = renderMonthlyPrompt(data, 'Июль 2026');

    // Агрегаты и форматирование (целые рубли с разбивкой по разрядам).
    expect(prompt).toContain('Июль 2026');
    expect(prompt).toContain('1 180 000 ₽'); // приход
    expect(prompt).toContain('490 000 ₽'); // прибыль кассы
    expect(prompt).toContain('41.29%'); // маржа %
    expect(prompt).toContain('Закупка ЗИП');
    expect(prompt).toContain('Алероев');
    expect(prompt).toContain('УЗИ');
    // Число должников — в строке «должны всего»; просроченные счета — в строке «просрочено».
    expect(prompt).toContain('должников: 4');
    expect(prompt).toContain('просроченных счетов: 6');

    // Регресс на находку ревью: общее число должников (4) НЕ должно попадать в предложение
    // «из них просрочено» — там только просроченные счета (6). Не смешиваем два множества.
    const overdueLine = prompt.split('\n').find((l) => l.includes('просрочено')) ?? '';
    expect(overdueLine).toContain('6');
    expect(overdueLine).not.toContain('4');

    // ПДн клиентов в промпт не попадают: имя должника, которого мы НЕ клали в data, отсутствует.
    expect(prompt).not.toContain('Иванов');
    // Модель типа/инженер — единственные «имена»; в data нет поля с ФИО клиента вообще.
    expect(prompt).not.toMatch(/клиент[а-я]* (ООО|ИП|«)/i);
  });

  it('renderMonthlyPrompt: marginPercent = null не ломает строку маржи', () => {
    const data: MonthlySummaryData = {
      cash: {
        incomeKopecks: '0',
        expenseKopecks: '0',
        profitKopecks: '0',
        topExpenses: [],
        balanceTotalKopecks: '0',
        balanceCashKopecks: '0',
        balanceNonCashKopecks: '0',
      },
      profit: {
        closedOrdersCount: 0,
        revenueKopecks: '0',
        costKopecks: '0',
        marginKopecks: '0',
        marginPercent: null,
        topEngineer: null,
        topEquipment: null,
      },
      receivables: {
        totalRemainingKopecks: '0',
        overdueRemainingKopecks: '0',
        debtorCount: 0,
        overdueInvoiceCount: 0,
      },
    };
    const prompt = renderMonthlyPrompt(data, 'Январь 2026');
    expect(prompt).toContain('маржа (прибыль по ремонтам): 0 ₽');
    expect(prompt).not.toContain('null');
    expect(prompt).not.toContain('%)'); // процент не дописан
  });
});
