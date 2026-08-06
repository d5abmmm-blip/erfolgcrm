/**
 * Stage 10'.F — тесты модуля metrology.
 *
 * Проверяем:
 *   1. upsertSiDetails создаёт detail и проставляет assets.requires_metrology=true.
 *   2. removeSiDetails сбрасывает флаг requires_metrology.
 *   3. addCalibration с result='passed' — nextCalibrationAt = max(performedAt+months, validUntil).
 *   4. addCalibration с result='failed' — nextCalibrationAt = today + 7 дней.
 *   5. listSi с status='overdue' — только просроченные.
 *   6. getOverdueAndSoon — границы: overdue (yesterday), soon (today+30), ok (today+31).
 *   7. cross-tenant: SI erfolg не виден из demo.
 *   8. getDashboardStats — корректные счётчики.
 *   9. addCalibration без upsertSiDetails — ошибка.
 *  10. listCalibrations отдаёт записи в порядке убывания performedAt.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assets, getDb, metrologyCalibrations, metrologySiDetails, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  addCalibration,
  getDashboardStats,
  getOverdueAndSoon,
  getSi,
  listCalibrations,
  listSi,
  removeSiDetails,
  upsertSiDetails,
} from '../modules/metrology/repository';

const TYPE_PREFIX = 'TEST-METRO-';

let erfolgId = '';
let demoId = '';
const erfolgAssetIds: string[] = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  // Подгружаем 3 ассета erfolg — будем использовать в тестах.
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: assets.id }).from(assets).limit(3),
  );
  for (const r of rows) erfolgAssetIds.push(r.id);
  if (erfolgAssetIds.length < 2) {
    throw new Error('seed missing assets for metrology tests');
  }
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      // Сначала calibrations (FK на asset).
      await tx
        .delete(metrologyCalibrations)
        .where(like(metrologyCalibrations.notes, `${TYPE_PREFIX}%`));
      await tx
        .delete(metrologySiDetails)
        .where(like(metrologySiDetails.typeName, `${TYPE_PREFIX}%`));
      // Сброс requires_metrology у тестовых ассетов.
      for (const aid of erfolgAssetIds) {
        await tx.update(assets).set({ requiresMetrology: false }).where(eq(assets.id, aid));
      }
    });
  }
}

beforeEach(clearTestData);

const ONE_DAY = 24 * 60 * 60 * 1000;
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return isoDate(new Date());
}
function isoOffset(days: number): string {
  return isoDate(new Date(Date.now() + days * ONE_DAY));
}
function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return isoDate(dt);
}

describe('upsertSiDetails / removeSiDetails', () => {
  it('создаёт detail и ставит assets.requires_metrology=true', async () => {
    const aid = erfolgAssetIds[0]!;
    const row = await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Манометр`,
      calibrationIntervalMonths: 12,
      accuracyClass: '0.6',
      measurementRange: '0…600 мм рт. ст.',
    });
    expect(row.assetId).toBe(aid);
    expect(row.typeName).toBe(`${TYPE_PREFIX}Манометр`);

    const [a] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ requiresMetrology: assets.requiresMetrology })
        .from(assets)
        .where(eq(assets.id, aid)),
    );
    expect(a?.requiresMetrology).toBe(true);
  });

  it('removeSiDetails — soft delete + сброс requires_metrology', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}ToRemove`,
      calibrationIntervalMonths: 12,
    });

    const removed = await removeSiDetails(getDb(), erfolgId, aid);
    expect(removed).toBe(true);

    const after = await getSi(getDb(), erfolgId, aid);
    expect(after).toBeNull();

    const [a] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ requiresMetrology: assets.requiresMetrology })
        .from(assets)
        .where(eq(assets.id, aid)),
    );
    expect(a?.requiresMetrology).toBe(false);
  });

  it('upsert повторно для того же ассета — обновление, не дубль', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}First`,
      calibrationIntervalMonths: 12,
    });
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Second`,
      calibrationIntervalMonths: 24,
    });
    const row = await getSi(getDb(), erfolgId, aid);
    expect(row?.typeName).toBe(`${TYPE_PREFIX}Second`);
    expect(row?.calibrationIntervalMonths).toBe(24);
  });
});

describe('addCalibration', () => {
  it('passed: nextCalibrationAt = max(performedAt+months, validUntil)', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Pass`,
      calibrationIntervalMonths: 12,
    });
    const performedAt = todayIso();
    const validUntil = isoOffset(370); // дальше чем +12 месяцев
    const cal = await addCalibration(getDb(), erfolgId, aid, {
      performedAt,
      validUntil,
      result: 'passed',
      certificateNumber: 'СВ-001',
      calibratorOrg: 'ФБУ ЦСМ',
      notes: `${TYPE_PREFIX}passed`,
    });
    expect(cal.result).toBe('passed');

    const detail = await getSi(getDb(), erfolgId, aid);
    expect(detail?.lastCalibrationAt).toBe(performedAt);
    // Должен взять более поздний из (performedAt+12mo, validUntil)
    expect(detail?.nextCalibrationAt).toBe(validUntil);
  });

  it('passed: если interval больше validUntil — берётся interval', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}IntervalWins`,
      calibrationIntervalMonths: 12,
    });
    const performedAt = todayIso();
    const validUntil = isoOffset(30); // намного раньше +12 месяцев
    await addCalibration(getDb(), erfolgId, aid, {
      performedAt,
      validUntil,
      result: 'passed',
      notes: `${TYPE_PREFIX}intervalwins`,
    });
    const detail = await getSi(getDb(), erfolgId, aid);
    const expected = addMonthsIso(performedAt, 12);
    expect(detail?.nextCalibrationAt).toBe(expected);
  });

  it('failed: nextCalibrationAt = today + 7 дней', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Fail`,
      calibrationIntervalMonths: 12,
    });
    await addCalibration(getDb(), erfolgId, aid, {
      performedAt: todayIso(),
      validUntil: todayIso(),
      result: 'failed',
      notes: `${TYPE_PREFIX}failed`,
    });
    const detail = await getSi(getDb(), erfolgId, aid);
    expect(detail?.nextCalibrationAt).toBe(isoOffset(7));
    // lastCalibrationAt НЕ должен обновляться при failed.
    expect(detail?.lastCalibrationAt).toBeNull();
  });

  it('addCalibration без upsertSiDetails — ошибка', async () => {
    const aid = erfolgAssetIds[1]!;
    await expect(
      addCalibration(getDb(), erfolgId, aid, {
        performedAt: todayIso(),
        validUntil: todayIso(),
        result: 'passed',
        notes: `${TYPE_PREFIX}orphan`,
      }),
    ).rejects.toThrow(/SI details not found/);
  });
});

describe('listSi / getOverdueAndSoon / getDashboardStats', () => {
  async function setupAssetWithNext(nextDateIso: string, label: string) {
    const aid = erfolgAssetIds.shift();
    if (!aid) throw new Error('out of test assets');
    erfolgAssetIds.push(aid);
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}${label}`,
      calibrationIntervalMonths: 12,
    });
    // Прямо проставим next через прямой UPDATE в БД (минуя addCalibration).
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .update(metrologySiDetails)
        .set({ nextCalibrationAt: nextDateIso, lastCalibrationAt: isoOffset(-300) })
        .where(eq(metrologySiDetails.assetId, aid)),
    );
    return aid;
  }

  it('listSi status=overdue возвращает только просроченные', async () => {
    const overdueAid = await setupAssetWithNext(isoOffset(-3), 'Overdue');
    await setupAssetWithNext(isoOffset(15), 'Soon');
    await setupAssetWithNext(isoOffset(60), 'Ok');

    const overdue = await listSi(getDb(), erfolgId, { status: 'overdue' });
    const ids = overdue.map((r) => r.assetId);
    expect(ids).toContain(overdueAid);
    expect(overdue.every((r) => r.status === 'overdue')).toBe(true);
  });

  it('getOverdueAndSoon: yesterday→overdue, today+30→soon, today+31→ok', async () => {
    const overdueAid = await setupAssetWithNext(isoOffset(-1), 'O1');
    const soonAid = await setupAssetWithNext(isoOffset(30), 'S30');
    const okAid = await setupAssetWithNext(isoOffset(31), 'OK31');

    const { overdue, soon } = await getOverdueAndSoon(getDb(), erfolgId, 30);
    expect(overdue.find((r) => r.assetId === overdueAid)).toBeDefined();
    expect(soon.find((r) => r.assetId === soonAid)).toBeDefined();
    expect(soon.find((r) => r.assetId === okAid)).toBeUndefined();
    expect(overdue.find((r) => r.assetId === okAid)).toBeUndefined();
  });

  it('getDashboardStats считает корректно', async () => {
    await setupAssetWithNext(isoOffset(-2), 'D-Over');
    await setupAssetWithNext(isoOffset(10), 'D-Soon');
    await setupAssetWithNext(isoOffset(60), 'D-Ok');

    const stats = await getDashboardStats(getDb(), erfolgId);
    expect(stats.totalSiCount).toBeGreaterThanOrEqual(3);
    expect(stats.overdueCount).toBeGreaterThanOrEqual(1);
    expect(stats.soonCount).toBeGreaterThanOrEqual(1);
  });
});

describe('listCalibrations', () => {
  it('возвращает в порядке убывания performedAt', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Hist`,
      calibrationIntervalMonths: 12,
    });
    await addCalibration(getDb(), erfolgId, aid, {
      performedAt: isoOffset(-200),
      validUntil: isoOffset(165),
      result: 'passed',
      notes: `${TYPE_PREFIX}older`,
    });
    await addCalibration(getDb(), erfolgId, aid, {
      performedAt: isoOffset(-30),
      validUntil: isoOffset(335),
      result: 'passed',
      notes: `${TYPE_PREFIX}newer`,
    });
    const list = await listCalibrations(getDb(), erfolgId, aid);
    const tested = list.filter((c) => c.notes?.startsWith(TYPE_PREFIX));
    expect(tested.length).toBe(2);
    expect(tested[0]!.performedAt >= tested[1]!.performedAt).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it('SI erfolg не виден из demo', async () => {
    const aid = erfolgAssetIds[0]!;
    await upsertSiDetails(getDb(), erfolgId, aid, {
      typeName: `${TYPE_PREFIX}Secret`,
      calibrationIntervalMonths: 12,
    });
    const fromDemo = await getSi(getDb(), demoId, aid);
    expect(fromDemo).toBeNull();
    const listFromDemo = await listSi(getDb(), demoId, { status: 'all' });
    expect(listFromDemo.find((r) => r.assetId === aid)).toBeUndefined();
  });
});
