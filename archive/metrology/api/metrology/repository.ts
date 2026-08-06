/**
 * Metrology repository — реестр СИ + журнал поверок.
 *
 * Бизнес-инварианты:
 * - При upsertSiDetails синхронно проставляется assets.requires_metrology = true.
 * - При removeSiDetails (soft delete) — assets.requires_metrology = false.
 * - addCalibration атомарно вставляет запись и пересчитывает last/nextCalibrationAt:
 *     passed: next = max(performedAt + interval months, validUntil)
 *     failed: next = today + 7 дней (повторная поверка)
 *
 * Все запросы к таблицам — ТОЛЬКО через withTenantTx.
 */
import { and, desc, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm';
import {
  assets,
  clients,
  metrologyCalibrations,
  metrologySiDetails,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type CalibrationStatus = 'overdue' | 'soon' | 'ok' | 'never';
export type CalibrationResult = 'passed' | 'failed';

export interface SiRow {
  assetId: string;
  assetModel: string;
  assetSerial: string | null;
  assetInventory: string | null;
  ownerClientId: string | null;
  ownerClientName: string | null;
  typeName: string;
  patternRegistryNumber: string | null;
  accuracyClass: string | null;
  measurementRange: string | null;
  calibrationIntervalMonths: number;
  lastCalibrationAt: string | null;
  nextCalibrationAt: string | null;
  status: CalibrationStatus;
}

export interface SiInput {
  typeName: string;
  patternRegistryNumber?: string | null;
  accuracyClass?: string | null;
  measurementRange?: string | null;
  calibrationIntervalMonths: number;
}

export interface CalibrationRow {
  id: string;
  assetId: string;
  performedAt: string;
  validUntil: string;
  certificateNumber: string | null;
  calibratorOrg: string | null;
  result: CalibrationResult;
  notes: string | null;
  documentAttachmentId: string | null;
  createdAt: Date;
}

export interface CalibrationInput {
  performedAt: string; // 'YYYY-MM-DD'
  validUntil: string;
  certificateNumber?: string | null;
  calibratorOrg?: string | null;
  result: CalibrationResult;
  notes?: string | null;
  documentAttachmentId?: string | null;
}

const DEFAULT_SOON_DAYS = 30;
const FAILED_RETRY_DAYS = 7;

/** YYYY-MM-DD от Date в UTC. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Сегодня (UTC) как 'YYYY-MM-DD'. */
function todayIso(): string {
  return toIsoDate(new Date());
}

/** Прибавить calendar months к ISO-дате (без TZ-сдвигов). */
function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCMonth(date.getUTCMonth() + months);
  return toIsoDate(date);
}

/** Прибавить calendar days к ISO-дате. */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/** Возвращает максимум двух ISO-дат лексикографически (для валидных YYYY-MM-DD это корректно). */
function maxIsoDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function computeStatus(
  nextCalibrationAt: string | null,
  soonDays = DEFAULT_SOON_DAYS,
): CalibrationStatus {
  if (!nextCalibrationAt) return 'never';
  const today = todayIso();
  if (nextCalibrationAt < today) return 'overdue';
  const diff = daysBetweenIso(today, nextCalibrationAt);
  if (diff <= soonDays) return 'soon';
  return 'ok';
}

export interface ListSiOpts {
  clientId?: string;
  status?: 'overdue' | 'soon' | 'ok' | 'all';
  search?: string;
}

export async function listSi(db: Db, tenantId: string, opts: ListSiOpts = {}): Promise<SiRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [isNull(metrologySiDetails.deletedAt)];
    if (opts.clientId) filters.push(eq(assets.ownerClientId, opts.clientId));
    const rows = await tx
      .select({
        assetId: metrologySiDetails.assetId,
        assetModel: assets.model,
        assetSerial: assets.serialNumber,
        assetInventory: assets.inventoryNumber,
        ownerClientId: assets.ownerClientId,
        ownerClientName: clients.displayName,
        typeName: metrologySiDetails.typeName,
        patternRegistryNumber: metrologySiDetails.patternRegistryNumber,
        accuracyClass: metrologySiDetails.accuracyClass,
        measurementRange: metrologySiDetails.measurementRange,
        calibrationIntervalMonths: metrologySiDetails.calibrationIntervalMonths,
        lastCalibrationAt: metrologySiDetails.lastCalibrationAt,
        nextCalibrationAt: metrologySiDetails.nextCalibrationAt,
      })
      .from(metrologySiDetails)
      .leftJoin(assets, eq(metrologySiDetails.assetId, assets.id))
      .leftJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(and(...filters));

    const search = opts.search?.trim().toLowerCase();
    return rows
      .map((r) => ({
        assetId: r.assetId,
        assetModel: r.assetModel ?? '—',
        assetSerial: r.assetSerial,
        assetInventory: r.assetInventory,
        ownerClientId: r.ownerClientId,
        ownerClientName: r.ownerClientName,
        typeName: r.typeName,
        patternRegistryNumber: r.patternRegistryNumber,
        accuracyClass: r.accuracyClass,
        measurementRange: r.measurementRange,
        calibrationIntervalMonths: r.calibrationIntervalMonths,
        lastCalibrationAt: r.lastCalibrationAt,
        nextCalibrationAt: r.nextCalibrationAt,
        status: computeStatus(r.nextCalibrationAt),
      }))
      .filter((r) => {
        if (opts.status && opts.status !== 'all' && r.status !== opts.status) return false;
        if (search) {
          const hay = [
            r.assetModel,
            r.assetSerial,
            r.assetInventory,
            r.ownerClientName,
            r.typeName,
            r.patternRegistryNumber,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Просроченные первыми, потом soon, потом ok, потом never; внутри — по nextCalibrationAt asc.
        const order: Record<CalibrationStatus, number> = {
          overdue: 0,
          soon: 1,
          ok: 2,
          never: 3,
        };
        const byStatus = order[a.status] - order[b.status];
        if (byStatus !== 0) return byStatus;
        return (a.nextCalibrationAt ?? '9999').localeCompare(b.nextCalibrationAt ?? '9999');
      });
  });
}

export async function getSi(db: Db, tenantId: string, assetId: string): Promise<SiRow | null> {
  const all = await listSi(db, tenantId, { status: 'all' });
  return all.find((r) => r.assetId === assetId) ?? null;
}

export async function upsertSiDetails(
  db: Db,
  tenantId: string,
  assetId: string,
  input: SiInput,
): Promise<SiRow> {
  await withTenantTx(db, tenantId, async (tx) => {
    // Проверим что asset существует в этом tenant'е (RLS защитит, но дадим явную ошибку).
    const found = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!found[0]) {
      throw new Error('Asset not found in this tenant');
    }

    const existing = await tx
      .select()
      .from(metrologySiDetails)
      .where(eq(metrologySiDetails.assetId, assetId))
      .limit(1);

    if (existing[0]) {
      await tx
        .update(metrologySiDetails)
        .set({
          typeName: input.typeName.trim(),
          patternRegistryNumber: input.patternRegistryNumber ?? null,
          accuracyClass: input.accuracyClass ?? null,
          measurementRange: input.measurementRange ?? null,
          calibrationIntervalMonths: input.calibrationIntervalMonths,
          deletedAt: null,
        })
        .where(eq(metrologySiDetails.assetId, assetId));
    } else {
      await tx.insert(metrologySiDetails).values({
        assetId,
        tenantId,
        typeName: input.typeName.trim(),
        patternRegistryNumber: input.patternRegistryNumber ?? null,
        accuracyClass: input.accuracyClass ?? null,
        measurementRange: input.measurementRange ?? null,
        calibrationIntervalMonths: input.calibrationIntervalMonths,
      });
    }

    await tx.update(assets).set({ requiresMetrology: true }).where(eq(assets.id, assetId));
  });

  const result = await getSi(db, tenantId, assetId);
  if (!result) throw new Error('upsertSiDetails: row missing after upsert');
  return result;
}

export async function removeSiDetails(db: Db, tenantId: string, assetId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(metrologySiDetails)
      .set({ deletedAt: new Date() })
      .where(and(eq(metrologySiDetails.assetId, assetId), isNull(metrologySiDetails.deletedAt)))
      .returning({ id: metrologySiDetails.assetId });
    if (updated.length === 0) return false;
    await tx.update(assets).set({ requiresMetrology: false }).where(eq(assets.id, assetId));
    return true;
  });
}

export async function addCalibration(
  db: Db,
  tenantId: string,
  assetId: string,
  input: CalibrationInput,
): Promise<CalibrationRow> {
  return withTenantTx(db, tenantId, async (tx) => {
    const detailRows = await tx
      .select()
      .from(metrologySiDetails)
      .where(eq(metrologySiDetails.assetId, assetId))
      .limit(1);
    const detail = detailRows[0];
    if (!detail) {
      throw new Error('SI details not found for this asset');
    }

    const inserted = await tx
      .insert(metrologyCalibrations)
      .values({
        tenantId,
        assetId,
        performedAt: input.performedAt,
        validUntil: input.validUntil,
        certificateNumber: input.certificateNumber ?? null,
        calibratorOrg: input.calibratorOrg ?? null,
        result: input.result,
        notes: input.notes ?? null,
        documentAttachmentId: input.documentAttachmentId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('addCalibration: insert returned nothing');

    // Пересчёт last/next.
    let nextAt: string;
    let lastAt: string | null = detail.lastCalibrationAt;
    if (input.result === 'passed') {
      const byInterval = addMonthsIso(input.performedAt, detail.calibrationIntervalMonths);
      nextAt = maxIsoDate(byInterval, input.validUntil);
      lastAt = input.performedAt;
    } else {
      // failed: повторная поверка через 7 дней. lastAt НЕ обновляем (последняя успешная).
      nextAt = addDaysIso(todayIso(), FAILED_RETRY_DAYS);
    }

    await tx
      .update(metrologySiDetails)
      .set({
        lastCalibrationAt: lastAt,
        nextCalibrationAt: nextAt,
      })
      .where(eq(metrologySiDetails.assetId, assetId));

    return {
      id: row.id,
      assetId: row.assetId,
      performedAt: row.performedAt,
      validUntil: row.validUntil,
      certificateNumber: row.certificateNumber,
      calibratorOrg: row.calibratorOrg,
      result: row.result,
      notes: row.notes,
      documentAttachmentId: row.documentAttachmentId,
      createdAt: row.createdAt,
    };
  });
}

export async function listCalibrations(
  db: Db,
  tenantId: string,
  assetId: string,
): Promise<CalibrationRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(metrologyCalibrations)
      .where(
        and(eq(metrologyCalibrations.assetId, assetId), isNull(metrologyCalibrations.deletedAt)),
      )
      .orderBy(desc(metrologyCalibrations.performedAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      performedAt: r.performedAt,
      validUntil: r.validUntil,
      certificateNumber: r.certificateNumber,
      calibratorOrg: r.calibratorOrg,
      result: r.result,
      notes: r.notes,
      documentAttachmentId: r.documentAttachmentId,
      createdAt: r.createdAt,
    }));
  });
}

export interface OverdueAndSoon {
  overdue: SiRow[];
  soon: SiRow[];
}

/** Группирует СИ по статусу (для дашборда и cron-уведомлений). */
export async function getOverdueAndSoon(
  db: Db,
  tenantId: string,
  daysSoon = DEFAULT_SOON_DAYS,
): Promise<OverdueAndSoon> {
  const all = await listSi(db, tenantId, { status: 'all' });
  const today = todayIso();
  const soonHorizon = addDaysIso(today, daysSoon);
  const overdue: SiRow[] = [];
  const soon: SiRow[] = [];
  for (const r of all) {
    if (!r.nextCalibrationAt) continue;
    if (r.nextCalibrationAt < today) {
      overdue.push(r);
    } else if (r.nextCalibrationAt <= soonHorizon) {
      soon.push(r);
    }
  }
  return { overdue, soon };
}

export interface DashboardStats {
  overdueCount: number;
  soonCount: number;
  totalSiCount: number;
}

export async function getDashboardStats(db: Db, tenantId: string): Promise<DashboardStats> {
  return withTenantTx(db, tenantId, async (tx) => {
    const total = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(metrologySiDetails)
      .where(isNull(metrologySiDetails.deletedAt));
    const today = todayIso();
    const soonHorizon = addDaysIso(today, DEFAULT_SOON_DAYS);
    const overdue = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(metrologySiDetails)
      .where(
        and(isNull(metrologySiDetails.deletedAt), lt(metrologySiDetails.nextCalibrationAt, today)),
      );
    const soon = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(metrologySiDetails)
      .where(
        and(
          isNull(metrologySiDetails.deletedAt),
          gte(metrologySiDetails.nextCalibrationAt, today),
          lte(metrologySiDetails.nextCalibrationAt, soonHorizon),
        ),
      );
    return {
      totalSiCount: Number(total[0]?.c ?? 0),
      overdueCount: Number(overdue[0]?.c ?? 0),
      soonCount: Number(soon[0]?.c ?? 0),
    };
  });
}

/** Найти СИ с next_calibration_at точно через N дней (для cron-напоминаний). */
export async function findCalibrationsDueInDays(
  db: Db,
  tenantId: string,
  inDays: number,
): Promise<SiRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const targetDate = addDaysIso(todayIso(), inDays);
    const rows = await tx
      .select({
        assetId: metrologySiDetails.assetId,
        assetModel: assets.model,
        assetSerial: assets.serialNumber,
        assetInventory: assets.inventoryNumber,
        ownerClientId: assets.ownerClientId,
        ownerClientName: clients.displayName,
        typeName: metrologySiDetails.typeName,
        patternRegistryNumber: metrologySiDetails.patternRegistryNumber,
        accuracyClass: metrologySiDetails.accuracyClass,
        measurementRange: metrologySiDetails.measurementRange,
        calibrationIntervalMonths: metrologySiDetails.calibrationIntervalMonths,
        lastCalibrationAt: metrologySiDetails.lastCalibrationAt,
        nextCalibrationAt: metrologySiDetails.nextCalibrationAt,
      })
      .from(metrologySiDetails)
      .leftJoin(assets, eq(metrologySiDetails.assetId, assets.id))
      .leftJoin(clients, eq(assets.ownerClientId, clients.id))
      .where(
        and(
          isNull(metrologySiDetails.deletedAt),
          eq(metrologySiDetails.nextCalibrationAt, targetDate),
        ),
      );
    return rows.map((r) => ({
      assetId: r.assetId,
      assetModel: r.assetModel ?? '—',
      assetSerial: r.assetSerial,
      assetInventory: r.assetInventory,
      ownerClientId: r.ownerClientId,
      ownerClientName: r.ownerClientName,
      typeName: r.typeName,
      patternRegistryNumber: r.patternRegistryNumber,
      accuracyClass: r.accuracyClass,
      measurementRange: r.measurementRange,
      calibrationIntervalMonths: r.calibrationIntervalMonths,
      lastCalibrationAt: r.lastCalibrationAt,
      nextCalibrationAt: r.nextCalibrationAt,
      status: computeStatus(r.nextCalibrationAt),
    }));
  });
}
