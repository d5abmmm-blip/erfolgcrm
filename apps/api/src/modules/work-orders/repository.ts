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
import { TRPCError } from '@trpc/server';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { tickets, users, workOrders, workOrderLines, withTenantTx, type Db } from '@erfolg/db';
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
  /** Исходник инженера, написанный своими словами (см. compose-notes.ts). */
  engineerNotes: string | null;
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
  /**
   * Клиентский id для ВСТАВКИ (lineId отсутствует). Реплей офлайн-очереди с
   * тем же newLineId не создаёт вторую строку: INSERT … ON CONFLICT (id)
   * DO UPDATE (guard по workOrderId) доносит последнее состояние строки.
   */
  newLineId?: string | null;
}

export interface UpdateHeaderInput {
  diagnosis?: string | null;
  repairDescription?: string | null;
  recommendation?: string | null;
  engineerNotes?: string | null;
  vatRate?: VatRate;
  engineerId?: string | null;
}

/**
 * Снимок «что человек видел в поле, когда правил» — для реплея офлайн-очереди.
 *
 * Сторож ПО ЗНАЧЕНИЮ поля, а не по updatedAt наряда, намеренно: updatedAt
 * дёргает любой пересчёт итогов (правка строк), и две свои офлайн-правки
 * разных полей делят один момент времени — сторож по времени давал бы ложные
 * отказы на собственных правках. Значения же полей независимы.
 */
export interface HeaderBaseSnapshot {
  diagnosis?: string | null;
  repairDescription?: string | null;
  recommendation?: string | null;
  engineerNotes?: string | null;
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
      engineerNotes: workOrders.engineerNotes,
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

/** Суммы строк наряда по видам, в целых копейках. */
export interface LineAmounts {
  works: bigint;
  parts: bigint;
  expenses: bigint;
  /** Сумма works + parts + expenses — то, что строки дают в итог. */
  all: bigint;
}

/**
 * Суммы строк наряда по видам. Снимается ДО правки строки: по разнице между шапкой и
 * этим снимком видно, сколько в шапке пришло НЕ из строк (см. resolveLegacyRemainder).
 */
async function sumLineAmounts(tx: Tx, workOrderId: string): Promise<LineAmounts> {
  const rows = await tx
    .select({
      lineType: workOrderLines.lineType,
      sumAmount: sql<string>`COALESCE(SUM(${workOrderLines.amountKopecks}), 0)`,
    })
    .from(workOrderLines)
    .where(eq(workOrderLines.workOrderId, workOrderId))
    .groupBy(workOrderLines.lineType);

  let works = 0n;
  let parts = 0n;
  let expenses = 0n;
  for (const row of rows) {
    const amount = BigInt(row.sumAmount);
    if (row.lineType === 'work') works = amount;
    else if (row.lineType === 'part') parts = amount;
    else if (row.lineType === 'expense') expenses = amount;
  }
  return { works, parts, expenses, all: works + parts + expenses };
}

/**
 * «Сколько в шапке сверх строк» — сумма, пришедшая из старой программы.
 *
 * ЗАЩИТА ИМПОРТИРОВАННЫХ НАРЯДОВ, третий случай той же болезни (после себестоимости и
 * оплаты). Импорт кладёт в шапку суммы старой программы — ORDERSUM в итог, WORKSUM и
 * DETAILSUM в работы и запчасти (`import-winservice.ts`), — а строки грузит отдельными
 * таблицами, и сойтись они не обязаны: в старой системе итог заказа мог быть выставлен
 * помимо позиций, а часть нарядов пришла вовсе без строк. Пересчёт же безусловно ставил
 * «сумма по строкам», то есть ПЕРВАЯ ЖЕ правка строки стирала историческую сумму
 * наряда, а удаление строки обнуляло её совсем.
 *
 * Разница считается ДО операции: после вставки или удаления строки она уже другая.
 * У обычного наряда шапка всегда равна сумме строк (её же и поддерживает пересчёт),
 * разница выходит нулевой, и поведение не меняется.
 */
function resolveLegacyRemainder(header: bigint, linesBefore: bigint): bigint {
  return header > linesBefore ? header - linesBefore : 0n;
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
  lineAmountsBefore: LineAmounts,
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
  // Суммы старой программы, которые в шапке лежат помимо строк. Читаем шапку ДО
  // записи — она ещё хранит прежние значения (обновляет её только этот запрос ниже).
  const [header] = await tx
    .select({
      works: workOrders.worksAmountKopecks,
      parts: workOrders.partsAmountKopecks,
      expenses: workOrders.expensesAmountKopecks,
      total: workOrders.totalAmountKopecks,
    })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)));

  const legacyWorks = resolveLegacyRemainder(header?.works ?? 0n, lineAmountsBefore.works);
  const legacyParts = resolveLegacyRemainder(header?.parts ?? 0n, lineAmountsBefore.parts);
  const legacyExpenses = resolveLegacyRemainder(header?.expenses ?? 0n, lineAmountsBefore.expenses);
  // Итог держит СВОЮ разницу, а не сумму трёх: в старой программе ORDERSUM мог не
  // совпадать с WORKSUM + DETAILSUM, и исторический итог надо сохранить как есть.
  const legacyTotal = resolveLegacyRemainder(header?.total ?? 0n, lineAmountsBefore.all);

  const worksTotal = works + legacyWorks;
  const partsTotal = parts + legacyParts;
  const expensesTotal = expenses + legacyExpenses;
  const total = works + parts + expenses + legacyTotal;
  const headerCost = await resolveHeaderCost(tx, tenantId, workOrderId, cost, lineCostBefore);
  await tx
    .update(workOrders)
    .set({
      worksAmountKopecks: worksTotal,
      partsAmountKopecks: partsTotal,
      expensesAmountKopecks: expensesTotal,
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
 *   - 'part':    0. Себестоимость запчасти проставляет ТОЛЬКО выдача со склада
 *     (inventory-movements/repository.ts — средневзвешенная по фактически списанным
 *     партиям), и она же кладёт её в строку. Считать «по нынешним партиям» здесь
 *     нельзя: это подставило бы сегодняшние цены в наряд двухлетней давности.
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

  // part — себестоимость появится при выдаче со склада, здесь считать нечего.
  return 0n;
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
    // Тем же снимком по суммам строк отличается историческая сумма наряда из старой
    // программы: без него первая же правка строки стирала её.
    const lineAmountsBefore = await sumLineAmounts(tx, workOrderId);
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
        engineerId: input.engineerId ?? null,
        unitPriceKopecks: input.unitPriceKopecks,
      });
      const values = {
        // Клиентский id (если прислан) делает вставку идемпотентной: реплей
        // офлайн-очереди с тем же newLineId попадает в ON CONFLICT и доносит
        // последнее состояние строки вместо второй вставки (счёт ×2, сделка ×2).
        ...(input.newLineId ? { id: input.newLineId } : {}),
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
      };
      const inserted = await tx
        .insert(workOrderLines)
        .values(values)
        .onConflictDoUpdate({
          target: workOrderLines.id,
          set: {
            lineType: values.lineType,
            name: values.name,
            unit: values.unit,
            quantity: values.quantity,
            unitPriceKopecks: values.unitPriceKopecks,
            amountKopecks: values.amountKopecks,
            costPerUnitKopecks: values.costPerUnitKopecks,
            engineerId: values.engineerId,
            comment: values.comment,
            orderIdx: values.orderIdx,
          },
          // Обновлять можно только строку СВОЕГО наряда: чужой id (коллизия или
          // злоупотребление) не перезаписывается — вставка «не происходит»,
          // returning пуст, ниже это превращается в явный отказ.
          setWhere: eq(workOrderLines.workOrderId, workOrderId),
        })
        .returning({ id: workOrderLines.id });
      const newId = inserted[0]?.id;
      if (!newId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Строка с таким номером уже существует в другом наряде.',
        });
      }
      resultId = newId;
    }
    await recalcTotals(tx, tenantId, workOrderId, lineCostBefore, lineAmountsBefore);
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
    const lineAmountsBefore = await sumLineAmounts(tx, workOrderId);
    await tx
      .delete(workOrderLines)
      .where(and(eq(workOrderLines.id, lineId), eq(workOrderLines.workOrderId, workOrderId)));
    await recalcTotals(tx, tenantId, workOrderId, lineCostBefore, lineAmountsBefore);
  });
}

export async function updateWorkOrderHeader(
  db: Db,
  tenantId: string,
  workOrderId: string,
  patch: UpdateHeaderInput,
  opts?: { base?: HeaderBaseSnapshot },
): Promise<void> {
  const setObj: Record<string, unknown> = {};
  if (patch.diagnosis !== undefined) setObj.diagnosis = patch.diagnosis;
  if (patch.repairDescription !== undefined) setObj.repairDescription = patch.repairDescription;
  if (patch.recommendation !== undefined) setObj.recommendation = patch.recommendation;
  if (patch.engineerNotes !== undefined) setObj.engineerNotes = patch.engineerNotes;
  if (patch.vatRate !== undefined) setObj.vatRate = patch.vatRate;
  if (patch.engineerId !== undefined) setObj.engineerId = patch.engineerId;
  if (Object.keys(setObj).length === 0) return;

  // Атомарно: условие «поле всё ещё такое, каким его видел человек» живёт в
  // самом UPDATE, а не в отдельном SELECT — окна между проверкой и записью нет.
  const base = opts?.base;
  const guards: SQL[] = [];
  if (base) {
    if (base.diagnosis !== undefined)
      guards.push(sql`${workOrders.diagnosis} IS NOT DISTINCT FROM ${base.diagnosis}`);
    if (base.repairDescription !== undefined)
      guards.push(
        sql`${workOrders.repairDescription} IS NOT DISTINCT FROM ${base.repairDescription}`,
      );
    if (base.recommendation !== undefined)
      guards.push(sql`${workOrders.recommendation} IS NOT DISTINCT FROM ${base.recommendation}`);
    if (base.engineerNotes !== undefined)
      guards.push(sql`${workOrders.engineerNotes} IS NOT DISTINCT FROM ${base.engineerNotes}`);
  }

  await withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(workOrders)
      .set(setObj)
      .where(and(eq(workOrders.id, workOrderId), ...guards))
      .returning({ id: workOrders.id });
    if (guards.length > 0 && updated.length === 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'Наряд уже изменён позже вашей правки — она не применена, чтобы не затереть свежее. Обновите экран и при необходимости повторите.',
      });
    }
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

/**
 * Заявка, к наряду которой относится строка.
 *
 * Нужна проверке «своя ли заявка»: списание со склада приходит с
 * идентификатором СТРОКИ наряда, а решение о доступе принимается по заявке.
 */
export async function ticketIdForWorkOrderLine(
  db: Db,
  tenantId: string,
  lineId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ ticketId: workOrders.ticketId })
      .from(workOrderLines)
      .innerJoin(workOrders, eq(workOrderLines.workOrderId, workOrders.id))
      .where(eq(workOrderLines.id, lineId))
      .limit(1);
    return rows[0]?.ticketId ?? null;
  });
}
