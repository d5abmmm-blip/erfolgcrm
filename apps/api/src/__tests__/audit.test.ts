/**
 * Stage 10'.D — тесты модуля audit (только чтение).
 *
 * Проверяем:
 *   1. listAuditLogs возвращает записи в порядке убывания ts.
 *   2. Фильтр по action работает.
 *   3. Фильтр по entityType работает.
 *   4. Фильтр по userId работает.
 *   5. Фильтр по dateFrom/dateTo (включительно).
 *   6. Поиск по entityId/ip/userAgent (case-insensitive).
 *   7. Cursor-пагинация: вторая страница не пересекается с первой.
 *   8. listEntityTypes возвращает уникальные значения.
 *   9. getAuditStats считает 24ч/7д/login_failed.
 *  10. Cross-tenant: записи erfolg не видны из demo.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLogs, getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { writeAudit } from '../lib/audit';
import { getAuditStats, listAuditLogs, listEntityTypes } from '../modules/audit/repository';

const ENTITY_TYPE = 'audit_test_entity';

let erfolgId = '';
let demoId = '';
let testUserId: string | null = null;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  // Возьмём id любого пользователя erfolg, чтобы привязывать записи.
  const rows = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const { users } = await import('@erfolg/db');
    return tx.select({ id: users.id }).from(users).limit(1);
  });
  testUserId = rows[0]?.id ?? null;
  if (!testUserId) throw new Error('seed missing users');
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(auditLogs).where(eq(auditLogs.entityType, ENTITY_TYPE));
    });
  }
}

beforeEach(clearTestData);

async function seedRows(
  count: number,
  opts: { tenantId?: string; ip?: string; spread?: boolean } = {},
) {
  const tid = opts.tenantId ?? erfolgId;
  for (let i = 0; i < count; i++) {
    await writeAudit(getDb(), tid, {
      userId: testUserId,
      action: 'create',
      entityType: ENTITY_TYPE,
      entityId: `entity-${i}`,
      after: { idx: i },
      ip: opts.ip ?? '10.0.0.1',
      userAgent: `TestUA/${i}`,
    });
  }
}

describe('listAuditLogs', () => {
  it('возвращает записи в порядке убывания ts', async () => {
    await seedRows(3);
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
    });
    expect(res.rows.length).toBe(3);
    for (let i = 1; i < res.rows.length; i++) {
      const prev = res.rows[i - 1]?.ts.getTime() ?? 0;
      const cur = res.rows[i]?.ts.getTime() ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it('фильтр по action работает', async () => {
    await seedRows(2);
    await writeAudit(getDb(), erfolgId, {
      userId: testUserId,
      action: 'delete',
      entityType: ENTITY_TYPE,
      entityId: 'entity-deleted',
    });
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      actions: ['delete'],
    });
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.action).toBe('delete');
    expect(res.rows[0]?.entityId).toBe('entity-deleted');
  });

  it('фильтр по entityType работает', async () => {
    await seedRows(2);
    await writeAudit(getDb(), erfolgId, {
      userId: testUserId,
      action: 'create',
      entityType: 'other_entity',
      entityId: 'foo',
    });
    const onlyOurs = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
    });
    expect(onlyOurs.rows.every((r) => r.entityType === ENTITY_TYPE)).toBe(true);
    expect(onlyOurs.rows.length).toBe(2);
    // подчистим лишний
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.delete(auditLogs).where(eq(auditLogs.entityType, 'other_entity')),
    );
  });

  it('фильтр по userId работает', async () => {
    await seedRows(2);
    // Запись без user_id (system).
    await writeAudit(getDb(), erfolgId, {
      userId: null,
      action: 'create',
      entityType: ENTITY_TYPE,
      entityId: 'system-entry',
    });
    const byUser = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      userId: testUserId!,
    });
    expect(byUser.rows.every((r) => r.userId === testUserId)).toBe(true);
    expect(byUser.rows.length).toBe(2);
  });

  it('фильтр по dateFrom/dateTo (включительно)', async () => {
    await seedRows(1);
    const today = new Date().toISOString().slice(0, 10);
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      dateFrom: today,
      dateTo: today,
    });
    expect(res.rows.length).toBe(1);
  });

  it('фильтр dateTo в прошлом отдаёт пусто', async () => {
    await seedRows(1);
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      dateTo: '2020-01-01',
    });
    expect(res.rows.length).toBe(0);
  });

  it('поиск по IP (case-insensitive substring)', async () => {
    await seedRows(2, { ip: '192.168.55.10' });
    await writeAudit(getDb(), erfolgId, {
      userId: testUserId,
      action: 'create',
      entityType: ENTITY_TYPE,
      entityId: 'other-ip',
      ip: '10.20.30.40',
    });
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      search: '192.168',
    });
    expect(res.rows.length).toBe(2);
    expect(res.rows.every((r) => r.ip === '192.168.55.10')).toBe(true);
  });

  it('поиск по entityId', async () => {
    await seedRows(3);
    const res = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      search: 'entity-1',
    });
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.entityId).toBe('entity-1');
  });

  it('cursor-пагинация: вторая страница не пересекается с первой', async () => {
    await seedRows(7);
    const page1 = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      limit: 3,
    });
    expect(page1.rows.length).toBe(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.rows.length).toBe(3);
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    expect(page2.rows.every((r) => !page1Ids.has(r.id))).toBe(true);
  });
});

describe('listEntityTypes', () => {
  it('возвращает уникальные значения', async () => {
    await seedRows(2);
    const types = await listEntityTypes(getDb(), erfolgId);
    expect(types.includes(ENTITY_TYPE)).toBe(true);
    // уникальность
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('getAuditStats', () => {
  it('считает события за 24 часа и 7 дней', async () => {
    const before = await getAuditStats(getDb(), erfolgId);
    await seedRows(3);
    const after = await getAuditStats(getDb(), erfolgId);
    expect(after.last24hCount).toBeGreaterThanOrEqual(before.last24hCount + 3);
    expect(after.last7dCount).toBeGreaterThanOrEqual(before.last7dCount + 3);
  });

  it('failedLoginsLast24h учитывает только login_failed', async () => {
    const before = await getAuditStats(getDb(), erfolgId);
    await writeAudit(getDb(), erfolgId, {
      userId: null,
      action: 'login_failed',
      entityType: ENTITY_TYPE,
      entityId: 'wrong-user',
      ip: '1.2.3.4',
    });
    const after = await getAuditStats(getDb(), erfolgId);
    expect(after.failedLoginsLast24h).toBe(before.failedLoginsLast24h + 1);
  });
});

describe('cross-tenant', () => {
  it('записи erfolg не видны из demo', async () => {
    await seedRows(2, { tenantId: erfolgId, ip: '8.8.8.8' });
    await seedRows(1, { tenantId: demoId, ip: '8.8.8.8' });
    const fromErfolg = await listAuditLogs(getDb(), erfolgId, {
      entityTypes: [ENTITY_TYPE],
    });
    const fromDemo = await listAuditLogs(getDb(), demoId, {
      entityTypes: [ENTITY_TYPE],
    });
    expect(fromErfolg.rows.length).toBe(2);
    expect(fromDemo.rows.length).toBe(1);
    // entityId'ы не должны пересекаться
    const ids1 = new Set(fromErfolg.rows.map((r) => r.id));
    const ids2 = new Set(fromDemo.rows.map((r) => r.id));
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });
});
