/**
 * Профиль инженера: навыки (типы техники) и занятость (выходной/отпуск/выезд).
 * Чистые DB-функции; RLS по tenant соблюдается через withTenantTx.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  userAvailability,
  userDeviceSkills,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type AvailabilityKind = 'day_off' | 'vacation' | 'onsite';

export interface SkillRow {
  userId: string;
  deviceType: string;
}

/** Все навыки тенанта (небольшой объём — фронт группирует по инженеру). */
export async function listSkills(db: Db, tenantId: string): Promise<SkillRow[]> {
  return withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ userId: userDeviceSkills.userId, deviceType: userDeviceSkills.deviceType })
      .from(userDeviceSkills)
      .orderBy(asc(userDeviceSkills.deviceType)),
  );
}

/**
 * Заменить набор навыков инженера целиком (delete + insert в одной tx).
 * Значения тримятся и дедуплицируются (case-insensitive). Возвращает новый список.
 */
export async function setSkills(
  db: Db,
  tenantId: string,
  userId: string,
  deviceTypes: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of deviceTypes) {
    const t = raw.trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    clean.push(t);
  }
  return withTenantTx(db, tenantId, async (tx) => {
    await tx.delete(userDeviceSkills).where(eq(userDeviceSkills.userId, userId));
    if (clean.length > 0) {
      await tx.insert(userDeviceSkills).values(
        clean.map((deviceType) => ({ tenantId, userId, deviceType })),
      );
    }
    return clean;
  });
}

export interface AvailabilityRow {
  id: string;
  userId: string;
  kind: AvailabilityKind;
  dateFrom: string;
  dateTo: string;
  note: string | null;
}

/** Занятость (опц. по инженеру), отсортировано по дате начала (сначала свежие). */
export async function listAvailability(
  db: Db,
  tenantId: string,
  userId?: string,
): Promise<AvailabilityRow[]> {
  return withTenantTx(db, tenantId, (tx) =>
    tx
      .select({
        id: userAvailability.id,
        userId: userAvailability.userId,
        kind: userAvailability.kind,
        dateFrom: userAvailability.dateFrom,
        dateTo: userAvailability.dateTo,
        note: userAvailability.note,
      })
      .from(userAvailability)
      .where(userId ? eq(userAvailability.userId, userId) : undefined)
      .orderBy(asc(userAvailability.dateFrom)),
  );
}

/** Занятость, актуальная на дату onDate (YYYY-MM-DD): dateFrom ≤ onDate ≤ dateTo. */
export async function listActiveAvailability(
  db: Db,
  tenantId: string,
  onDate: string,
): Promise<Array<{ userId: string; kind: AvailabilityKind }>> {
  return withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ userId: userAvailability.userId, kind: userAvailability.kind })
      .from(userAvailability)
      .where(
        and(lte(userAvailability.dateFrom, onDate), gte(userAvailability.dateTo, onDate)),
      ),
  );
}

export async function setAvailability(
  db: Db,
  tenantId: string,
  input: {
    userId: string;
    kind: AvailabilityKind;
    dateFrom: string;
    dateTo: string;
    note: string | null;
  },
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(userAvailability)
      .values({
        tenantId,
        userId: input.userId,
        kind: input.kind,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        note: input.note,
      })
      .returning({ id: userAvailability.id });
    return { id: inserted[0]!.id };
  });
}

export async function deleteAvailability(
  db: Db,
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenantTx(db, tenantId, (tx) =>
    tx.delete(userAvailability).where(eq(userAvailability.id, id)),
  );
}
