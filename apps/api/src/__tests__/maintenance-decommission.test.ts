/**
 * Списанная техника не должна оставаться в плане ТО.
 *
 * Раньше списанный аппарат навсегда висел в «Просрочено» и крутил счётчик в
 * меню: в модуле maintenance слово lifecycleStatus не встречалось ни разу.
 *
 * Чиним гашением is_active в момент списания, а НЕ фильтром по lifecycle_status
 * в списке. Причина: график ТО читают пять независимых запросов (список, две
 * плитки дашборда, бейдж меню, календарь), и все пять уже смотрят на is_active.
 * Погасив признак один раз, убираем аппарат отовсюду сразу и не заводим шестое
 * условие, от которого цифры разъедутся ещё сильнее. Тест стережёт оба конца:
 * и список, и счётчик меню.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  assets,
  clients,
  getDb,
  maintenanceSchedules,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { listSchedules } from '../modules/maintenance/repository';
import { decommissionAssetCmd } from '../modules/assets/service';
import { getNavBadgeCounts } from '../modules/dashboard/repository';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TESTDECOM-';

let erfolgId = '';
let clientId = '';
let directorId = '';
let tenantCtx: ResolvedTenant;
let sessionCtx: SessionData;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  directorId = usrs.find((u) => u.role === 'director')?.id ?? usrs[0]!.id;
  tenantCtx = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'ООО Эрфольг',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  sessionCtx = {
    tenantId: erfolgId,
    userId: directorId,
    username: 'director',
    role: 'director',
    fullName: 'Director',
    expiresAt: Date.now() + 60_000,
  } as unknown as SessionData;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM maintenance_schedules WHERE asset_id IN
        (SELECT id FROM assets WHERE model LIKE ${`${TEST_PREFIX}%`})
    `);
    await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);
afterAll(clearTestData);

async function makeAssetWithOverdueSchedule(): Promise<{ assetId: string; scheduleId: string }> {
  return withTenantTx(getDb(), erfolgId, async (tx) => {
    const a = await tx.execute<{ id: string }>(sql`
      INSERT INTO assets (tenant_id, owner_client_id, model, serial_number)
      VALUES (${erfolgId}::uuid, ${clientId}::uuid,
              ${`${TEST_PREFIX}Аппарат`}, ${`${TEST_PREFIX}${Date.now()}`})
      RETURNING id
    `);
    const assetId = (a as unknown as Array<{ id: string }>)[0]?.id;
    if (!assetId) throw new Error('insert asset failed');
    const [s] = await tx
      .insert(maintenanceSchedules)
      .values({
        tenantId: erfolgId,
        assetId,
        kind: 'planned',
        intervalDays: 90,
        // Срок в прошлом — график заведомо просрочен.
        nextDueAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        notes: `${TEST_PREFIX}график`,
      })
      .returning({ id: maintenanceSchedules.id });
    if (!s) throw new Error('insert schedule failed');
    return { assetId, scheduleId: s.id };
  });
}

describe('списание техники и графики ТО', () => {
  it('после списания график уходит из «Просрочено» и из счётчика меню', async () => {
    const { assetId, scheduleId } = await makeAssetWithOverdueSchedule();

    const before = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    expect(before.some((s) => s.id === scheduleId)).toBe(true);
    const badgesBefore = await getNavBadgeCounts(getDb(), erfolgId, 'director', directorId);

    await decommissionAssetCmd(
      getDb(),
      tenantCtx,
      sessionCtx,
      { ip: null, userAgent: null },
      assetId,
      'списан в тесте',
    );

    const after = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    expect(after.some((s) => s.id === scheduleId)).toBe(false);

    // И счётчик в меню тоже — иначе цифры разошлись бы между списком и бейджем.
    const badgesAfter = await getNavBadgeCounts(getDb(), erfolgId, 'director', directorId);
    expect(badgesAfter.maintenanceOverdue).toBe(badgesBefore.maintenanceOverdue - 1);
  });

  it('график не удаляется, а помечается неактивным — история цела', async () => {
    const { assetId, scheduleId } = await makeAssetWithOverdueSchedule();
    await decommissionAssetCmd(
      getDb(),
      tenantCtx,
      sessionCtx,
      { ip: null, userAgent: null },
      assetId,
    );

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ isActive: maintenanceSchedules.isActive })
        .from(maintenanceSchedules)
        .where(eq(maintenanceSchedules.id, scheduleId)),
    );
    expect(row?.isActive).toBe(false);

    const inactive = await listSchedules(getDb(), erfolgId, { filter: 'inactive' });
    expect(inactive.some((s) => s.id === scheduleId)).toBe(true);
  });

  it('графики чужой техники не трогаются', async () => {
    const mine = await makeAssetWithOverdueSchedule();
    const other = await makeAssetWithOverdueSchedule();

    await decommissionAssetCmd(
      getDb(),
      tenantCtx,
      sessionCtx,
      { ip: null, userAgent: null },
      mine.assetId,
    );

    const overdue = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    expect(overdue.some((s) => s.id === other.scheduleId)).toBe(true);
  });
});

describe('список графиков ТО', () => {
  it('показывает клиента — без него непонятно, куда ехать', async () => {
    const { scheduleId } = await makeAssetWithOverdueSchedule();

    const rows = await listSchedules(getDb(), erfolgId, { filter: 'overdue' });
    const row = rows.find((s) => s.id === scheduleId);
    expect(row?.clientId).toBe(clientId);
    expect(row?.clientName).toBeTruthy();
  });
});
