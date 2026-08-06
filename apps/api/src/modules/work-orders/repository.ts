/**
 * Repository для work_orders / work_order_lines.
 *
 * Бизнес-инвариант: work_orders.{works,parts,expenses,total}_amount_kopecks
 * материализованы — пересчитываются recalcTotals() в одной транзакции с
 * upsert/delete строки. Никаких других путей правки этих сумм нет.
 *
 * Все денежные значения в БД — bigint (копейки). В DTO сериализуются как string,
 * чтобы корректно проходить через superjson и BigInt-парсинг на фронте.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import {
  inventoryBatches,
  tickets,
  users,
  workOrders,
  workOrderLines,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import type { VatRate, WorkOrderLineType } from '@erfolg/shared';
import { getEngineerWorkPercentTx, laborCostPerUnitKopecks } from '../payroll/repository';

type Tx = PgTransaction<never, never, never>;

export interface WorkOrderLineDto {
  id: string;
  lineType: WorkOrderLineType;
  name: string;
  unit: string;
  /** numeric → string */
  quantity: string;
  /** bigint → string копейки */
  unitPriceKopecks: string;
  /** bigint → string копейки */
  amountKopecks: string;
  /** 8.C: snapshot себестоимости единицы (копейки), bigint → string. */
  costPerUnitKopecks: string;
  engineerId: string | null;
  engineerName: string | null;
  comment: string | null;
  /** Если не null — строка привязана к позиции склада (была списана через FEFO). */
  inventoryItemId: string | null;
  orderIdx: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkOrderDto {
  id: string;
  ticketId: string;
  orderNumber: string;
  engineerId: string | null;
  engineerName: string | null;
  diagnosis: string | null;
  repairDescription: string | null;
  recommendation: string | null;
  vatRate: VatRate;
  worksAmountKopecks: string;
  partsAmountKopecks: string;
  expensesAmountKopecks: string;
  totalAmountKopecks: string;
  /** 8.C: материализованная себестоимость и маржа (копейки), bigint → string. */
  costAmountKopecks: string;
  marginAmountKopecks: string;
  lines: WorkOrderLineDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertLineInput {
  lineType: WorkOrderLineType;
  name: string;
  unit: string;
  /** numeric-совместимая строка ("1", "0.5", "12.345") */
  quantity: string;
  /** В копейках (bigint). Service пересчитывает из рублей. */
  unitPriceKopecks: bigint;
  engineerId?: string | null;
  comment?: string | null;
  orderIdx?: number;
}

export interface UpdateHeaderInput {
  diagnosis?: string | null;
  repairDescription?: string | null;
  recommendation?: string | null;
  vatRate?: VatRate;
  engineerId?: string | null;
}

function toLineDto(row: {
  id: string;
  lineType: WorkOrderLineType;
  name: string;
  unit: string;
  quantity: string;
  unitPriceKopecks: bigint;
  amountKopecks: bigint;
  costPerUnitKopecks: bigint;
  engineerId: string | null;
  engineerName: string | null;
  comment: string | null;
  inventoryItemId: string | null;
  orderIdx: number;
  createdAt: Date;
  updatedAt: Date;
}): WorkOrderLineDto {
  return {
    ...row,
    unitPriceKopecks: row.unitPriceKopecks.toString(),
    amountKopecks: row.amountKopecks.toString(),
    costPerUnitKopecks: row.costPerUnitKopecks.toString(),
  };
}

async function selectLines(tx: Tx, workOrderId: string): Promise<WorkOrderLineDto[]> {
  const rows = await tx
    .select({
      id: workOrderLines.id,
      lineType: workOrderLines.lineType,
      name: workOrderLines.name,
      unit: workOrderLines.unit,
      quantity: workOrderLines.quantity,
      unitPriceKopecks: workOrderLines.unitPriceKopecks,
      amountKopecks: workOrderLines.amountKopecks,
      costPerUnitKopecks: workOrderLines.costPerUnitKopecks,
      engineerId: workOrderLines.engineerId,
      engineerName: users.fullName,
      comment: workOrderLines.comment,
      inventoryItemId: workOrderLines.inventoryItemId,
      orderIdx: workOrderLines.orderIdx,
      createdAt: workOrderLines.createdAt,
      updatedAt: workOrderLines.updatedAt,
    })
    .from(workOrderLines)
    .leftJoin(users, eq(workOrderLines.engineerId, users.id))
    .where(eq(workOrderLines.workOrderId, workOrderId))
    .orderBy(asc(workOrderLines.orderIdx), asc(workOrderLines.createdAt));
  return rows.map(toLineDto);
}

async function selectHeader(tx: Tx, filter: SQL): Promise<Omit<WorkOrderDto, 'lines'> | null> {
  const rows = await tx
    .select({
      id: workOrders.id,
      ticketId: workOrders.ticketId,
      orderNumber: workOrders.orderNumber,
      engineerId: workOrders.engineerId,
      engineerName: users.fullName,
      diagnosis: workOrders.diagnosis,
      repairDescription: workOrders.repairDescription,
      recommendation: workOrders.recommendation,
      vatRate: workOrders.vatRate,
      worksAmountKopecks: workOrders.worksAmountKopecks,
      partsAmountKopecks: workOrders.partsAmountKopecks,
      expensesAmountKopecks: workOrders.expensesAmountKopecks,
      totalAmountKopecks: workOrders.totalAmountKopecks,
      costAmountKopecks: workOrders.costAmountKopecks,
      marginAmountKopecks: workOrders.marginAmountKopecks,
      createdAt: workOrders.createdAt,
      updatedAt: workOrders.updatedAt,
    })
    .from(workOrders)
    .leftJoin(users, eq(workOrders.engineerId, users.id))
    .where(filter)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    worksAmountKopecks: row.worksAmountKopecks.toString(),
    partsAmountKopecks: row.partsAmountKopecks.toString(),
    expensesAmountKopecks: row.expensesAmountKopecks.toString(),
    totalAmountKopecks: row.totalAmountKopecks.toString(),
    costAmountKopecks: row.costAmountKopecks.toString(),
    marginAmountKopecks: row.marginAmountKopecks.toString(),
  };
}

async function loadFullByTicket(tx: Tx, ticketId: string): Promise<WorkOrderDto | null> {
  const header = await selectHeader(tx, eq(workOrders.ticketId, ticketId));
  if (!header) return null;
  const lines = await selectLines(tx, header.id);
  return { ...header, lines };
}

export async function getWorkOrderByTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<WorkOrderDto | null> {
  return withTenantTx(db, tenantId, (tx) => loadFullByTicket(tx, ticketId));
}

/** Idempotent. Если наряд уже есть — просто возвращает его. */
export async function getOrCreateWorkOrder(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<WorkOrderDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await loadFullByTicket(tx, ticketId);
    if (existing) return existing;

    const ticketRows = await tx
      .select({ ticketNumber: tickets.ticketNumber })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    const ticketNumber = ticketRows[0]?.ticketNumber;
    if (!ticketNumber) throw new Error('getOrCreateWorkOrder: ticket not found');

    await tx
      .insert(workOrders)
      .values({ tenantId, ticketId, orderNumber: ticketNumber })
      .returning({ id: workOrders.id });
    const created = await loadFullByTicket(tx, ticketId);
    if (!created) throw new Error('getOrCreateWorkOrder: insert produced nothing');
    return created;
  });
}

function calcAmountKopecks(quantity: string, unitPrice: bigint): bigint {
  // numeric поддерживает scale 3 (см. schema). Преобразуем безопасно через целочисленную арифметику:
  // qty * 1000 → integer thousandths, перемножаем с unitPrice, делим на 1000.
  const trimmed = quantity.trim();
  const [intPart, fracRaw = ''] = trimmed.split('.');
  const frac = (fracRaw + '000').slice(0, 3);
  const thousandths = BigInt(`${intPart}${frac}`);
  // округление к ближайшему целому
  const numerator = thousandths * unitPrice;
  const half = 500n;
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  const rounded = (abs + half) / 1000n;
  return sign * rounded;
}

/**
 * Сумма себестоимости по строкам наряда, в целых копейках.
 * Считается ДО правки строки — по ней потом видно, несли строки себестоимость или нет
 * (см. защиту импортированной себестоимости в recalcTotals).
 */
export async function sumLineCostKopecks(tx: Tx, workOrderId: string): Promise<bigint> {
  const [row] = await tx
    .select({
      sumCost: sql<string>`COALESCE(SUM(${workOrderLines.costPerUnitKopecks} * ${workOrderLines.quantity}), 0)`,
    })
    .from(workOrderLines)
    .where(eq(workOrderLines.workOrderId, workOrderId));
  return BigInt(Math.round(Number(row?.sumCost ?? 0)));
}

/**
 * Себестоимость, которую записываем в шапку наряда.
 *
 * ЗАЩИТА ИМПОРТИРОВАННЫХ НАРЯДОВ. Наряды из старой системы (WinServisePro) хранят
 * себестоимость в ШАПКЕ (`import-winservice.ts` кладёт туда `EXPENSESSUM`), а по строкам
 * её нет вовсе — старая программа так не умела. Обычный пересчёт «сумма по строкам»
 * такое число молча обнулял, а вместе с ним портил маржу в отчёте «Рентабельность».
 * На боевой базе это 22 наряда на 137 056 ₽ — вся себестоимость, какая есть в системе.
 *
 * Признак «число пришло НЕ из строк»: строки не несли себестоимости ни ДО операции,
 * ни ПОСЛЕ. Тогда шапку не трогаем.
 *
 * ⚠️ Условие «ни до, ни после» здесь принципиально. Если проверять только «после»,
 * себестоимость станет ЛИПКОЙ: удалили единственную платную строку — цифра осталась
 * висеть, хотя стоять за ней уже нечему.
 */
async function resolveHeaderCost(
  tx: Tx,
  tenantId: string,
  workOrderId: string,
  costFromLines: bigint,
  lineCostBefore: bigint,
): Promise<bigint> {
  if (costFromLines !== 0n || lineCostBefore !== 0n) return costFromLines;
  const [header] = await tx
    .select({ cost: workOrders.costAmountKopecks })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)));
  return header && header.cost > 0n ? header.cost : costFromLines;
}

/**
 * Пересчитывает в шапке ТОЛЬКО себестоимость и маржу — с той же защитой импортированного
 * числа, что и recalcTotals. Нужен второму писателю этих колонок: выдаче запчасти со
 * склада (`inventory-movements/repository.ts`), которая суммы работ и запчастей не трогает.
 * Раньше та выдача пересчитывала себестоимость своим SQL и мимо всякой защиты — партия
 * с нулевой ценой закупки обнуляла историческую себестоимость ровно так же.
 */
export async function recalcWorkOrderCostFromLines(
  tx: Tx,
  tenantId: string,
  workOrderId: string,
  lineCostBefore: bigint,
): Promise<void> {
  const costFromLines = await sumLineCostKopecks(tx, workOrderId);
  const headerCost = await resolveHeaderCost(
    tx,
    tenantId,
    workOrderId,
    costFromLines,
    lineCostBefore,
  );
  const [wo] = await tx
    .select({ total: workOrders.totalAmountKopecks })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)));
  await tx
    .update(workOrders)
    .set({
      costAmountKopecks: headerCost,
      marginAmountKopecks: (wo?.total ?? 0n) - headerCost,
    })
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)));
}

async function recalcTotals(
  tx: Tx,
  tenantId: string,
  workOrderId: string,
  lineCostBefore: bigint,
): Promise<void> {
  const sums = await tx
    .select({
      lineType: workOrderLines.lineType,
      sumAmount: sql<string>`COALESCE(SUM(${workOrderLines.amountKopecks}), 0)`,
      // 8.C: SUM(cost_per_unit × quantity). Округление до копейки на каждой строке делалось при upsert,
      // здесь просто складываем материализованные значения.
      sumCost: sql<string>`COALESCE(SUM(${workOrderLines.costPerUnitKopecks} * ${workOrderLines.quantity}), 0)`,
    })
    .from(workOrderLines)
    .where(eq(workOrderLines.workOrderId, workOrderId))
    .groupBy(workOrderLines.lineType);

  let works = 0n;
  let parts = 0n;
  let expenses = 0n;
  let cost = 0n;
  for (const row of sums) {
    const amount = BigInt(row.sumAmount);
    // sumCost может быть numeric с дробной частью (qty=2.5 × cost). Округляем до целых копеек.
    const costPart = BigInt(Math.round(Number(row.sumCost)));
    if (row.lineType === 'work') works = amount;
    else if (row.lineType === 'part') parts = amount;
    else if (row.lineType === 'expense') expenses = amount;
    cost += costPart;
  }
  const total = works + parts + expenses;
  const headerCost = await resolveHeaderCost(tx, tenantId, workOrderId, cost, lineCostBefore);
  await tx
    .update(workOrders)
    .set({
      worksAmountKopecks: works,
      partsAmountKopecks: parts,
      expensesAmountKopecks: expenses,
      totalAmountKopecks: total,
      costAmountKopecks: headerCost,
      marginAmountKopecks: total - headerCost,
    })
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)));
}

/** Ответственный инженер наряда — на него падает работа, у которой нет своего исполнителя. */
async function workOrderEngineerId(tx: Tx, workOrderId: string): Promise<string | null> {
  const rows = await tx
    .select({ engineerId: workOrders.engineerId })
    .from(workOrders)
    .where(eq(workOrders.id, workOrderId))
    .limit(1);
  return rows[0]?.engineerId ?? null;
}

/**
 * 8.C: snapshot себестоимости единицы для строки наряда.
 *   - 'work':    ПРОЦЕНТ инженера от цены работы (его личный, иначе общее правило ЗП).
 *     Инженер берётся как в зарплате: строка → иначе ответственный по наряду.
 *     Инженера нет вовсе → 0.
 *   - 'part' c inventory_item_id: средневзвешенная цена закупки активных партий (quantity_remaining > 0).
 *     Если активных партий нет — берём cost из последней (по received_at) batch для item.
 *     Если партий вообще нет — 0.
 *   - 'part' БЕЗ item_id: 0 (свободная строка).
 *   - 'expense': unit_price (внутренний расход = его же цена; маржа таких строк = 0).
 *
 * ⚠️ Себестоимость работы БОЛЬШЕ НЕ ЗАВИСИТ от `users.hourly_cost_rate_kopecks`.
 * Причина — на бою все строки работ заведены в «шт», а не в «час» (замер 2026-07-24),
 * поэтому часовая ставка приравнивала бы 15-минутную работу к трёхдневной.
 * Колонка оставлена в базе, но ни на что не влияет.
 */
async function resolveLineCost(
  tx: Tx,
  input: {
    lineType: WorkOrderLineType;
    workOrderId: string;
    inventoryItemId?: string | null;
    engineerId?: string | null;
    unitPriceKopecks: bigint;
  },
): Promise<bigint> {
  if (input.lineType === 'expense') return input.unitPriceKopecks;

  if (input.lineType === 'work') {
    // Тот же порядок, что в расчёте ЗП: COALESCE(line.engineer_id, work_orders.engineer_id).
    // Иначе у строки без своего исполнителя себестоимость была бы 0, хотя деньги платятся.
    const engineerId = input.engineerId ?? (await workOrderEngineerId(tx, input.workOrderId));
    if (!engineerId) return 0n;
    const percent = await getEngineerWorkPercentTx(tx, engineerId);
    return laborCostPerUnitKopecks(input.unitPriceKopecks, percent);
  }

  // part
  if (!input.inventoryItemId) return 0n;
  // Средневзвешенная по активным партиям: SUM(unit_cost × remaining) / SUM(remaining).
  const wavg = await tx.execute(sql`
    SELECT
      CASE
        WHEN COALESCE(SUM(${inventoryBatches.quantityRemaining}), 0) > 0
        THEN ROUND(
          SUM(${inventoryBatches.unitCostKopecks} * ${inventoryBatches.quantityRemaining})
          / SUM(${inventoryBatches.quantityRemaining})
        )::text
        ELSE NULL
      END AS wavg
    FROM ${inventoryBatches}
    WHERE ${inventoryBatches.itemId} = ${input.inventoryItemId}::uuid
      AND ${inventoryBatches.quantityRemaining} > 0
  `);
  const wavgRows = wavg as unknown as Array<{ wavg: string | null }>;
  if (wavgRows[0]?.wavg) return BigInt(wavgRows[0].wavg);

  // Fallback: последняя partia
  const last = await tx
    .select({ cost: inventoryBatches.unitCostKopecks })
    .from(inventoryBatches)
    .where(eq(inventoryBatches.itemId, input.inventoryItemId))
    .orderBy(asc(inventoryBatches.receivedAt))
    .limit(1);
  return last[0]?.cost ?? 0n;
}

/**
 * Себестоимость при ПРАВКЕ строки: пересчитать или сохранить снимок.
 *
 * Правило одно: пересчитываем только тогда, когда пользователь сам сообщил
 * что-то, от чего себестоимость зависит. Во всех остальных случаях снимок
 * сохраняется — пересчёт «по текущему состоянию» подставил бы СЕГОДНЯШНИЕ
 * цифры в наряд двухлетней давности (средневзвешенная по нынешним партиям
 * склада, нынешняя ставка инженера). Это тихая подмена истории, она хуже
 * честного нуля.
 *
 *   • expense  — себестоимость это и есть цена, пересчитываем всегда,
 *                иначе у внутреннего расхода появится выдуманная маржа;
 *   • сменился тип строки — старый снимок бессмыслен, считаем заново;
 *   • work + прислали ДРУГОГО инженера — пользователь явно утверждает,
 *                что работу делал другой, снимок пересчитываем по нему;
 *   • во всех прочих случаях — СОХРАНЯЕМ.
 *
 * Настоящую себестоимость запчасти проставляет только выдача со склада
 * (inventory-movements/repository.ts — средневзвешенная по фактически
 * списанным партиям). Ниоткуда больше её взять нельзя: денежных колонок
 * в inventory_movements нет.
 */
async function resolveCostForUpdate(
  tx: Tx,
  workOrderId: string,
  input: UpsertLineInput,
  existing:
    | {
        lineType: WorkOrderLineType;
        engineerId: string | null;
        unitPriceKopecks: bigint;
        costPerUnitKopecks: bigint;
      }
    | undefined,
): Promise<bigint> {
  if (input.lineType === 'expense') return input.unitPriceKopecks;
  if (!existing) {
    return resolveLineCost(tx, {
      lineType: input.lineType,
      workOrderId,
      inventoryItemId: undefined,
      engineerId: input.engineerId ?? null,
      unitPriceKopecks: input.unitPriceKopecks,
    });
  }
  const typeChanged = existing.lineType !== input.lineType;
  const engineerChanged =
    input.engineerId !== undefined && input.engineerId !== existing.engineerId;
  // Себестоимость работы — ПРОЦЕНТ ОТ ЦЕНЫ, поэтому правка цены обязана её пересчитать.
  // При старой часовой ставке цена на себестоимость не влияла, и пересчёта не требовалось;
  // без этой ветки исправление цены оставило бы себестоимость от прежней суммы.
  const priceChanged = existing.unitPriceKopecks !== input.unitPriceKopecks;
  if (typeChanged || (input.lineType === 'work' && (engineerChanged || priceChanged))) {
    return resolveLineCost(tx, {
      lineType: input.lineType,
      workOrderId,
      inventoryItemId: undefined,
      // Поле не прислали → инженер строки НЕ меняется, берём прежнего.
      // Иначе правка одной только цены сбросила бы исполнителя на ответственного по наряду.
      engineerId: input.engineerId !== undefined ? input.engineerId : existing.engineerId,
      unitPriceKopecks: input.unitPriceKopecks,
    });
  }
  return existing.costPerUnitKopecks;
}

export async function upsertLine(
  db: Db,
  tenantId: string,
  workOrderId: string,
  lineId: string | null,
  input: UpsertLineInput,
): Promise<{ id: string }> {
  const amount = calcAmountKopecks(input.quantity, input.unitPriceKopecks);
  return withTenantTx(db, tenantId, async (tx) => {
    // Снимок «несли ли строки себестоимость» ДО правки — по нему recalcTotals отличает
    // историческую себестоимость из шапки от посчитанной по строкам.
    const lineCostBefore = await sumLineCostKopecks(tx, workOrderId);
    let resultId: string;
    if (lineId) {
      // Правка строки — ЧАСТИЧНАЯ. Веб шлёт только name/unit/quantity/unitPrice
      // (WorkOrderEditor), поэтому полная перезапись затирала бы то, чего в
      // запросе нет: себестоимость, инженера строки и комментарий.
      const [existing] = await tx
        .select({
          lineType: workOrderLines.lineType,
          engineerId: workOrderLines.engineerId,
          unitPriceKopecks: workOrderLines.unitPriceKopecks,
          costPerUnitKopecks: workOrderLines.costPerUnitKopecks,
        })
        .from(workOrderLines)
        .where(and(eq(workOrderLines.id, lineId), eq(workOrderLines.workOrderId, workOrderId)))
        .limit(1);

      const costPerUnit = await resolveCostForUpdate(tx, workOrderId, input, existing);

      await tx
        .update(workOrderLines)
        .set({
          lineType: input.lineType,
          name: input.name,
          unit: input.unit,
          quantity: input.quantity,
          unitPriceKopecks: input.unitPriceKopecks,
          amountKopecks: amount,
          costPerUnitKopecks: costPerUnit,
          // undefined = поле не прислали → не трогаем колонку.
          // Явный null = «убрать» и приходит только осознанно.
          ...(input.engineerId !== undefined ? { engineerId: input.engineerId } : {}),
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.orderIdx !== undefined ? { orderIdx: input.orderIdx } : {}),
        })
        .where(and(eq(workOrderLines.id, lineId), eq(workOrderLines.workOrderId, workOrderId)));
      resultId = lineId;
    } else {
      const costPerUnit = await resolveLineCost(tx, {
        lineType: input.lineType,
        workOrderId,
        inventoryItemId: undefined,
        engineerId: input.engineerId ?? null,
        unitPriceKopecks: input.unitPriceKopecks,
      });
      const inserted = await tx
        .insert(workOrderLines)
        .values({
          tenantId,
          workOrderId,
          lineType: input.lineType,
          name: input.name,
          unit: input.unit,
          quantity: input.quantity,
          unitPriceKopecks: input.unitPriceKopecks,
          amountKopecks: amount,
          costPerUnitKopecks: costPerUnit,
          engineerId: input.engineerId ?? null,
          comment: input.comment ?? null,
          orderIdx: input.orderIdx ?? 0,
        })
        .returning({ id: workOrderLines.id });
      const newId = inserted[0]?.id;
      if (!newId) throw new Error('upsertLine: insert returned nothing');
      resultId = newId;
    }
    await recalcTotals(tx, tenantId, workOrderId, lineCostBefore);
    return { id: resultId };
  });
}

export async function deleteLine(
  db: Db,
  tenantId: string,
  workOrderId: string,
  lineId: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const lineCostBefore = await sumLineCostKopecks(tx, workOrderId);
    await tx
      .delete(workOrderLines)
      .where(and(eq(workOrderLines.id, lineId), eq(workOrderLines.workOrderId, workOrderId)));
    await recalcTotals(tx, tenantId, workOrderId, lineCostBefore);
  });
}

export async function updateWorkOrderHeader(
  db: Db,
  tenantId: string,
  workOrderId: string,
  patch: UpdateHeaderInput,
): Promise<void> {
  const setObj: Record<string, unknown> = {};
  if (patch.diagnosis !== undefined) setObj.diagnosis = patch.diagnosis;
  if (patch.repairDescription !== undefined) setObj.repairDescription = patch.repairDescription;
  if (patch.recommendation !== undefined) setObj.recommendation = patch.recommendation;
  if (patch.vatRate !== undefined) setObj.vatRate = patch.vatRate;
  if (patch.engineerId !== undefined) setObj.engineerId = patch.engineerId;
  if (Object.keys(setObj).length === 0) return;
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.update(workOrders).set(setObj).where(eq(workOrders.id, workOrderId));
  });
}

/** Утилита для service: проверка что line принадлежит workOrder в рамках tenant. */
export async function workOrderExistsForTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.ticketId, ticketId))
      .limit(1);
    return rows.length > 0;
  });
}

export async function workOrderIdForTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.ticketId, ticketId))
      .limit(1);
    return rows[0]?.id ?? null;
  });
}
