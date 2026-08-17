/**
 * Service журнала посещений: правила заполнения табеля + аудит.
 *
 * Правила здесь, а не в zod-схеме роутера, потому что часть из них смысловая, а не
 * формальная: «время бывает только у явки» и «явку нельзя поставить будущим днём»
 * — это про то, что табель фиксирует ФАКТ. Отпуск, больничный и выходной вперёд
 * ставить можно: их планируют заранее.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { todayInTimezone } from '../../lib/org-day';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import {
  deleteRecord as repoDeleteRecord,
  fillDays as repoFillDays,
  listEmployees as repoListEmployees,
  listRecords as repoListRecords,
  upsertRecord as repoUpsertRecord,
  userExists,
  type AttendanceEmployeeDto,
  type AttendanceRecordDto,
  type AttendanceStatus,
} from './repository';

export interface MonthRange {
  /** YYYY-MM-DD, первое число месяца */
  from: string;
  /** YYYY-MM-DD, последнее число месяца */
  to: string;
}

/** Границы месяца как строки дат — без часовых поясов и Date-арифметики. */
export function monthRange(year: number, month: number): MonthRange {
  const mm = String(month).padStart(2, '0');
  // Date.UTC(y, m, 0) — «нулевой день» следующего месяца = последний день текущего.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

// «Сегодня» организации переехало в общее место (lib/org-day.ts) — здесь жила
// первая из пяти одинаковых копий. Реэкспорт сохранён: табель и его тесты
// исторически берут функцию отсюда.
export { todayInTimezone };

export interface AttendanceMonthDto {
  from: string;
  to: string;
  employees: AttendanceEmployeeDto[];
  records: AttendanceRecordDto[];
}

export async function monthQuery(
  db: Db,
  tenant: ResolvedTenant,
  input: { year: number; month: number },
): Promise<AttendanceMonthDto> {
  const range = monthRange(input.year, input.month);
  const records = await repoListRecords(db, tenant.id, range);
  const employees = await repoListEmployees(db, tenant.id, [
    ...new Set(records.map((r) => r.userId)),
  ]);
  return { ...range, employees, records };
}

/**
 * Дни периода включительно, YYYY-MM-DD. Конец раньше начала — пустой список, а не
 * бесконечный цикл. Считаем в UTC: тут только календарь, времени суток нет.
 */
export function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  const last = Date.parse(`${to}T00:00:00Z`);
  const cursor = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(last) || Number.isNaN(cursor.getTime())) return out;
  while (cursor.getTime() <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export interface UpsertInput {
  userId: string;
  workDate: string;
  status: AttendanceStatus;
  arrivedAt?: string | null;
  leftAt?: string | null;
  note?: string | null;
}

export async function upsertCmd(ctx: CmdCtx, input: UpsertInput): Promise<{ id: string }> {
  const arrivedAt = input.arrivedAt ?? null;
  const leftAt = input.leftAt ?? null;

  if (!(await userExists(ctx.db, ctx.tenant.id, input.userId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Сотрудник не найден' });
  }

  if (input.status !== 'present' && (arrivedAt || leftAt)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Время прихода и ухода бывает только у явки',
    });
  }

  if (leftAt && !arrivedAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Сначала укажите время прихода',
    });
  }

  if (arrivedAt && leftAt && leftAt <= arrivedAt) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Уход должен быть позже прихода',
    });
  }

  // Явка — это факт, а не план: завтрашним днём её не ставят. Отпуск, больничный,
  // командировку и выходной вперёд отмечать можно, их и планируют заранее.
  if (input.status === 'present' && input.workDate > todayInTimezone(ctx.tenant.timezone)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Явку нельзя отметить будущим днём — журнал фиксирует факт',
    });
  }

  const result = await repoUpsertRecord(ctx.db, ctx.tenant.id, {
    userId: input.userId,
    workDate: input.workDate,
    status: input.status,
    arrivedAt,
    leftAt,
    note: input.note?.trim() ? input.note.trim() : null,
  });

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: result.created ? 'create' : 'update',
    entityType: 'attendance_record',
    entityId: result.id,
    after: {
      userId: input.userId,
      workDate: input.workDate,
      status: input.status,
      arrivedAt,
      leftAt,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return { id: result.id };
}

/**
 * Больше квартала одним махом не заливаем: опечатка в годе («по 2119-й») не должна
 * забить табель на сто лет вперёд.
 */
const MAX_FILL_DAYS = 92;

export interface FillRangeInput {
  userId: string;
  dateFrom: string;
  dateTo: string;
  status: AttendanceStatus;
}

/**
 * Отметить период целиком одним видом дня — «внёс отпуск, проставилось и в табеле».
 *
 * Связь плана и табеля сознательно НЕ автоматическая (решение владельца 2026-08-14):
 * это отдельное действие по галочке человека, а не побочный эффект записи отсутствия.
 *
 * Уже отмеченные дни НЕ переписываем: в табеле лежит факт, который кто-то ставил
 * руками, и массовая заливка не имеет права его затирать. Пропуск делает сама база
 * через уникальный индекс — гонка двух менеджеров невозможна по построению.
 */
export async function fillRangeCmd(
  ctx: CmdCtx,
  input: FillRangeInput,
): Promise<{ created: number; skipped: number }> {
  if (input.status === 'present') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Явку отмечают по дням в журнале — оптом её не ставят',
    });
  }
  if (input.dateTo < input.dateFrom) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Дата окончания раньше даты начала',
    });
  }

  const days = enumerateDays(input.dateFrom, input.dateTo);
  if (days.length > MAX_FILL_DAYS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Период длиннее ${MAX_FILL_DAYS} дней — проверьте даты`,
    });
  }
  if (!(await userExists(ctx.db, ctx.tenant.id, input.userId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Сотрудник не найден' });
  }

  const createdDates = await repoFillDays(ctx.db, ctx.tenant.id, {
    userId: input.userId,
    dates: days,
    status: input.status,
  });

  if (createdDates.length > 0) {
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'create',
      entityType: 'attendance_record',
      after: {
        userId: input.userId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        status: input.status,
        created: createdDates.length,
        skipped: days.length - createdDates.length,
      },
      ip: ctx.audit.ip ?? null,
      userAgent: ctx.audit.userAgent ?? null,
    });
  }

  return { created: createdDates.length, skipped: days.length - createdDates.length };
}

export async function removeCmd(
  ctx: CmdCtx,
  input: { userId: string; workDate: string },
): Promise<{ removed: boolean }> {
  const id = await repoDeleteRecord(ctx.db, ctx.tenant.id, input);
  if (!id) return { removed: false };

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'attendance_record',
    entityId: id,
    before: { userId: input.userId, workDate: input.workDate },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });

  return { removed: true };
}
