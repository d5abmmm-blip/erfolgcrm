/**
 * Фича №12 «Рентабельность по инженеру / типу техники» — reports.profitability.
 *
 * profitabilityReport группирует закрытые наряды за период по инженеру и по типу техники,
 * суммируя УЖЕ материализованные total/cost/margin наряда. Период — по tickets.closed_at.
 *
 * Изоляция под ПАРАЛЛЕЛЬНЫЙ прогон файлов на общей БД:
 *   • свежий инженер (уникальный username) + уникальный device_type → строки отчёта
 *     находим по key и проверяем ТОЧНО;
 *   • «Не назначен» / «Без типа» — общие строки, проверяем абсолютным `>=`.
 *   • cleanup удаляет только тикеты по префиксу (каскадит наряды); users/assets НЕ трогаем —
 *     без нарядов они в отчёт не попадают (INNER JOIN work_orders).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assets, clients, getDb, tickets, users, withTenantTx, workOrders } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder } from '../modules/work-orders/repository';
import { profitabilityReport } from '../modules/reports/repository';

let erfolgId = '';
let clientId = '';
let seq = 0;

const PREFIX = 'TESTPROF-';
const USER_PREFIX = 'testprof-eng-';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
});

afterEach(async () => {
  // Чистим тестовое: тикеты (каскадом уходят наряды — work_orders.ticket_id ON DELETE CASCADE)
  // + активы + инженеры. Порядок для FK НЕ важен: tickets.asset_id / assigned_engineer_id и
  // work_orders.engineer_id — все ON DELETE SET NULL. Инженеров/активы удаляем не ради FK, а
  // чтобы лишние строки не ломали тесты, считающие их количество (без нарядов они в отчёт не
  // попадают — INNER JOIN work_orders).
  await withTenantTx(getDb(), erfolgId, async (tx) => {
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

async function makeAsset(deviceType: string | null): Promise<string> {
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

async function makeClosedWO(opts: {
  assetId: string | null;
  engineerId: string | null;
  closedDaysAgo: number;
  total: bigint;
  cost: bigint;
  margin: bigint;
  closed?: boolean;
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
      .set({
        status: opts.closed === false ? 'in_progress' : 'closed',
        closedAt: opts.closed === false ? null : new Date(Date.now() - opts.closedDaysAgo * 86_400_000),
      })
      .where(eq(tickets.id, ticketId));
  });
}

describe('reports.profitability — рентабельность (фича №12)', () => {
  it('группирует по инженеру и типу техники, считает маржу и маржу% точно', async () => {
    const engId = await makeEngineer('Тестовый Инженер');
    const deviceType = `${PREFIX}УЗИ-${Date.now()}`;
    const assetId = await makeAsset(deviceType);

    // 2 закрытых наряда: 100000/60000/40000 и 200000/110000/90000.
    await makeClosedWO({ assetId, engineerId: engId, closedDaysAgo: 1, total: 100_000n, cost: 60_000n, margin: 40_000n });
    await makeClosedWO({ assetId, engineerId: engId, closedDaysAgo: 2, total: 200_000n, cost: 110_000n, margin: 90_000n });

    const report = await profitabilityReport(getDb(), erfolgId, {});

    const eng = report.byEngineer.find((r) => r.key === engId);
    expect(eng).toBeDefined();
    if (!eng) return;
    expect(eng.name).toBe('Тестовый Инженер');
    expect(eng.closedOrdersCount).toBe(2);
    expect(eng.totalAmountKopecks).toBe('300000');
    expect(eng.costAmountKopecks).toBe('170000');
    expect(eng.marginAmountKopecks).toBe('130000');
    expect(eng.marginPercent).toBeCloseTo(43.33, 1);

    const eq = report.byEquipment.find((r) => r.key === deviceType);
    expect(eq).toBeDefined();
    if (!eq) return;
    expect(eq.name).toBe(deviceType);
    expect(eq.closedOrdersCount).toBe(2);
    expect(eq.totalAmountKopecks).toBe('300000');
    expect(eq.marginAmountKopecks).toBe('130000');
  });

  it('фильтр периода: наряд, закрытый вне периода, не попадает', async () => {
    const deviceType = `${PREFIX}OLD-${Date.now()}`;
    const assetId = await makeAsset(deviceType);
    await makeClosedWO({ assetId, engineerId: null, closedDaysAgo: 400, total: 500_000n, cost: 0n, margin: 500_000n });

    // Период — последние 30 дней; наряд закрыт 400 дней назад → исключён.
    const report = await profitabilityReport(getDb(), erfolgId, { from: isoDaysAgo(30), to: todayIso() });
    expect(report.byEquipment.find((r) => r.key === deviceType)).toBeUndefined();

    // Без периода — попадает.
    const all = await profitabilityReport(getDb(), erfolgId, {});
    expect(all.byEquipment.find((r) => r.key === deviceType)).toBeDefined();
  });

  it('наряд без инженера и без типа техники идёт в «Не назначен» / «Без типа»', async () => {
    // Мой безынженерный/безтиповый закрытый наряд гарантирует наличие null-строк.
    await makeClosedWO({ assetId: null, engineerId: null, closedDaysAgo: 1, total: 80_000n, cost: 20_000n, margin: 60_000n });

    const report = await profitabilityReport(getDb(), erfolgId, {});
    const noEng = report.byEngineer.find((r) => r.key === null);
    const noType = report.byEquipment.find((r) => r.key === null);
    expect(noEng).toBeDefined();
    expect(noEng?.name).toBe('Не назначен');
    expect(noType).toBeDefined();
    expect(noType?.name).toBe('Без типа');
  });

  it('незакрытый наряд не учитывается', async () => {
    const deviceType = `${PREFIX}OPEN-${Date.now()}`;
    const assetId = await makeAsset(deviceType);
    await makeClosedWO({ assetId, engineerId: null, closedDaysAgo: 0, total: 999_000n, cost: 0n, margin: 999_000n, closed: false });

    const report = await profitabilityReport(getDb(), erfolgId, {});
    expect(report.byEquipment.find((r) => r.key === deviceType)).toBeUndefined();
  });

  it('summary агрегирует суммы (>= вклада) и инвариант total = cost + margin по строке', async () => {
    const engId = await makeEngineer('Инженер Сводка');
    await makeClosedWO({ assetId: null, engineerId: engId, closedDaysAgo: 1, total: 100_000n, cost: 60_000n, margin: 40_000n });
    await makeClosedWO({ assetId: null, engineerId: engId, closedDaysAgo: 2, total: 200_000n, cost: 110_000n, margin: 90_000n });

    const report = await profitabilityReport(getDb(), erfolgId, {});
    // Сводка по всему тенанту → абсолютный минимум = наш вклад (параллельные тесты только добавляют).
    expect(BigInt(report.summary.totalAmountKopecks)).toBeGreaterThanOrEqual(300_000n);
    expect(BigInt(report.summary.costAmountKopecks)).toBeGreaterThanOrEqual(170_000n);
    expect(BigInt(report.summary.marginAmountKopecks)).toBeGreaterThanOrEqual(130_000n);
    expect(report.summary.closedOrdersCount).toBeGreaterThanOrEqual(2);
    expect(report.summary.marginPercent).not.toBeNull();

    // Инвариант по НАШЕЙ строке (изолированной): выручка = себестоимость + маржа.
    const row = report.byEngineer.find((r) => r.key === engId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(BigInt(row.totalAmountKopecks)).toBe(
      BigInt(row.costAmountKopecks) + BigInt(row.marginAmountKopecks),
    );
  });

  it('marginPercent = null при нулевой выручке; отрицательная маржа даёт отрицательный %', async () => {
    const engZero = await makeEngineer('Инженер Ноль');
    await makeClosedWO({ assetId: null, engineerId: engZero, closedDaysAgo: 1, total: 0n, cost: 0n, margin: 0n });

    const engLoss = await makeEngineer('Инженер Убыток');
    await makeClosedWO({ assetId: null, engineerId: engLoss, closedDaysAgo: 1, total: 100_000n, cost: 150_000n, margin: -50_000n });

    const report = await profitabilityReport(getDb(), erfolgId, {});
    const zero = report.byEngineer.find((r) => r.key === engZero);
    expect(zero).toBeDefined();
    expect(zero?.marginPercent).toBeNull();

    const loss = report.byEngineer.find((r) => r.key === engLoss);
    expect(loss).toBeDefined();
    expect(loss?.marginAmountKopecks).toBe('-50000');
    expect(loss?.marginPercent).toBeCloseTo(-50, 1);
  });
});
