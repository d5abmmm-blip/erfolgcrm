/**
 * Repository журнала посещений (табеля).
 *
 * Одна отметка на сотрудника в день — это держит уникальный индекс
 * `attendance_records_uniq`. Поэтому здесь именно upsert: сначала ищем строку дня,
 * потом UPDATE либо INSERT. Разница нужна не для скорости, а для аудита — иначе
 * в журнале 152-ФЗ любая правка выглядела бы как создание.
 */
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { attendanceRecords, users, withTenantTx, type Db } from '@erfolg/db';

export type AttendanceStatus =
  | 'present'
  | 'day_off'
  | 'sick'
  | 'vacation'
  | 'business_trip'
  | 'absent'
  | 'unpaid_leave';

export interface AttendanceRecordDto {
  id: string;
  userId: string;
  /** YYYY-MM-DD */
  workDate: string;
  status: AttendanceStatus;
  /** HH:MM либо null */
  arrivedAt: string | null;
  leftAt: string | null;
  note: string | null;
}

export interface AttendanceEmployeeDto {
  userId: string;
  fullName: string;
  role: 'director' | 'dispatcher' | 'engineer';
  /** Работает сейчас. Уволенный остаётся в табеле прошлых месяцев. */
  isActive: boolean;
}

/** Postgres отдаёт time как «09:00:00» — в табеле секунды не нужны. */
function toHhMm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

export interface UpsertAttendanceInput {
  userId: string;
  workDate: string;
  status: AttendanceStatus;
  arrivedAt: string | null;
  leftAt: string | null;
  note: string | null;
}

export async function listRecords(
  db: Db,
  tenantId: string,
  range: { from: string; to: string },
): Promise<AttendanceRecordDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: attendanceRecords.id,
        userId: attendanceRecords.userId,
        workDate: attendanceRecords.workDate,
        status: attendanceRecords.status,
        arrivedAt: attendanceRecords.arrivedAt,
        leftAt: attendanceRecords.leftAt,
        note: attendanceRecords.note,
      })
      .from(attendanceRecords)
      .where(
        and(gte(attendanceRecords.workDate, range.from), lte(attendanceRecords.workDate, range.to)),
      )
      .orderBy(asc(attendanceRecords.workDate));
    return rows.map((r) => ({
      ...r,
      arrivedAt: toHhMm(r.arrivedAt),
      leftAt: toHhMm(r.leftAt),
    }));
  });
}

/**
 * Сотрудники для сетки месяца: работающие сейчас ПЛЮС те, у кого есть отметки в
 * этом периоде. Второе слагаемое важно: уволенный в середине месяца должен
 * остаться в табеле за этот месяц, иначе распечатанный документ теряет строки.
 */
export async function listEmployees(
  db: Db,
  tenantId: string,
  withRecordsUserIds: string[],
): Promise<AttendanceEmployeeDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const activeOrInPeriod =
      withRecordsUserIds.length > 0
        ? or(eq(users.isActive, true), inArray(users.id, withRecordsUserIds))
        : eq(users.isActive, true);
    const rows = await tx
      .select({
        userId: users.id,
        fullName: users.fullName,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(isNull(users.deletedAt), activeOrInPeriod))
      .orderBy(asc(users.fullName));
    return rows;
  });
}

/** Есть ли такой сотрудник в этом тенанте (защита от чужого userId). */
export async function userExists(db: Db, tenantId: string, userId: string): Promise<boolean> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1),
  );
  return rows.length > 0;
}

export async function upsertRecord(
  db: Db,
  tenantId: string,
  input: UpsertAttendanceInput,
): Promise<{ id: string; created: boolean }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await tx
      .select({ id: attendanceRecords.id })
      .from(attendanceRecords)
      .where(
        and(
          eq(attendanceRecords.userId, input.userId),
          eq(attendanceRecords.workDate, input.workDate),
        ),
      )
      .limit(1);

    const values = {
      status: input.status,
      arrivedAt: input.arrivedAt,
      leftAt: input.leftAt,
      note: input.note,
    };

    const current = existing[0];
    if (current) {
      await tx.update(attendanceRecords).set(values).where(eq(attendanceRecords.id, current.id));
      return { id: current.id, created: false };
    }

    const inserted = await tx
      .insert(attendanceRecords)
      .values({ tenantId, userId: input.userId, workDate: input.workDate, ...values })
      .returning({ id: attendanceRecords.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('upsertRecord: insert returned nothing');
    return { id, created: true };
  });
}

/**
 * Проставить один вид дня на список дат, НЕ трогая уже отмеченные дни.
 * Возвращает даты, которые действительно завели.
 *
 * Пропуск существующих держит уникальный индекс attendance_records_uniq: сначала
 * прочитать, потом вставить — значит оставить щель, в которую пролезет второй
 * менеджер. `ON CONFLICT DO NOTHING` решает это в самой базе.
 */
export async function fillDays(
  db: Db,
  tenantId: string,
  input: { userId: string; dates: readonly string[]; status: AttendanceStatus },
): Promise<string[]> {
  if (input.dates.length === 0) return [];
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(attendanceRecords)
      .values(
        input.dates.map((workDate) => ({
          tenantId,
          userId: input.userId,
          workDate,
          status: input.status,
        })),
      )
      .onConflictDoNothing({
        target: [attendanceRecords.tenantId, attendanceRecords.userId, attendanceRecords.workDate],
      })
      .returning({ workDate: attendanceRecords.workDate });
    return inserted.map((r) => r.workDate);
  });
}

/** Снять отметку с дня. Возвращает id удалённой строки либо null, если её не было. */
export async function deleteRecord(
  db: Db,
  tenantId: string,
  key: { userId: string; workDate: string },
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const deleted = await tx
      .delete(attendanceRecords)
      .where(
        and(eq(attendanceRecords.userId, key.userId), eq(attendanceRecords.workDate, key.workDate)),
      )
      .returning({ id: attendanceRecords.id });
    return deleted[0]?.id ?? null;
  });
}
