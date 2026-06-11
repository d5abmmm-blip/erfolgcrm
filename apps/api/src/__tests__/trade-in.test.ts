/**
 * Трейд-ин (перенос из v1) — RLS + complete-инвариант + guards + roadmap smoke.
 *
 * Проверяем:
 *   1. completeTradeIn: status→sold + soldAt, владелец привязанного asset'а переносится
 *      на покупателя + событие owner_change в asset_events.
 *   2. Guards (service): complete без покупателя — BAD_REQUEST; повторный complete — BAD_REQUEST;
 *      update проданной позиции — BAD_REQUEST; status='sold' через update недоступен (тип).
 *   3. RLS: чужой тенант не видит позиции.
 *   4. tradeInStats: счётчики и маржа.
 *   5. roadmap: CRUD-цикл (create/list/update/archive).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  assetEvents,
  assets,
  clients,
  getDb,
  roadmapGoals,
  tradeInItems,
  users,
  withTenantTx,
} from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import {
  createTradeIn,
  getTradeInById,
  listTradeIns,
  tradeInStats,
} from '../modules/trade-in/repository';
import { completeTradeInCmd, updateTradeInCmd } from '../modules/trade-in/service';
import { archiveGoal, createGoal, listGoals, updateGoal } from '../modules/roadmap/repository';
import type { CmdCtx } from '../trpc/helpers';

let erfolgId = '';
let demoId = '';
let sellerId = '';
let buyerId = '';
let assetId = '';
let userId = '';

const STAMP = Date.now();
const TEST_PREFIX = `TEST-TI-${STAMP}`;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const u = await tx.select({ id: users.id }).from(users).limit(1);
    userId = u[0]!.id;
    const mkClient = async (suffix: string) => {
      const [c] = await tx
        .insert(clients)
        .values({
          tenantId: erfolgId,
          type: 'legal',
          subtype: 'commercial',
          displayName: `${TEST_PREFIX}-${suffix}`,
          status: 'active',
        })
        .returning({ id: clients.id });
      return c!.id;
    };
    sellerId = await mkClient('Seller');
    buyerId = await mkClient('Buyer');
    const [a] = await tx
      .insert(assets)
      .values({
        tenantId: erfolgId,
        ownerClientId: sellerId,
        model: `${TEST_PREFIX}-Defib X`,
        serialNumber: `${TEST_PREFIX}-SN`,
      })
      .returning({ id: assets.id });
    assetId = a!.id;
  });
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tradeInItems).where(like(tradeInItems.name, `${TEST_PREFIX}%`));
    await tx.delete(roadmapGoals).where(like(roadmapGoals.title, `${TEST_PREFIX}%`));
    await tx.delete(assetEvents).where(eq(assetEvents.assetId, assetId));
    await tx.delete(assets).where(like(assets.model, `${TEST_PREFIX}%`));
    await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
  });
});

function mkCmdCtx(): CmdCtx {
  return {
    db: getDb(),
    tenant: { id: erfolgId } as CmdCtx['tenant'],
    session: { userId } as CmdCtx['session'],
    audit: { ip: null, userAgent: null },
  };
}

describe('trade-in — complete переносит владельца техники', () => {
  it('полный цикл: создать → указать покупателя → complete → asset сменил владельца + owner_change', async () => {
    const { id } = await createTradeIn(getDb(), erfolgId, {
      name: `${TEST_PREFIX} Дефибриллятор`,
      clientId: sellerId,
      assetId,
      purchasePriceKopecks: 50_000_00n,
      assessedPriceKopecks: 80_000_00n,
      receivedAt: '2026-06-01',
    });

    // Покупатель через service-update
    await updateTradeInCmd(mkCmdCtx(), id, { buyerClientId: buyerId, status: 'in_stock' });

    // complete без цены нельзя? Можно — цена опциональна; передаём цену.
    const sold = await completeTradeInCmd(mkCmdCtx(), {
      id,
      salePriceKopecks: 120_000_00n,
    });
    expect(sold.status).toBe('sold');
    expect(sold.soldAt).toBeTruthy();
    expect(sold.salePriceKopecks).toBe('12000000');
    expect(sold.marginKopecks).toBe('7000000'); // 120k - 50k

    // Владелец asset'а перенесён + событие owner_change
    const [assetRow, events] = await withTenantTx(getDb(), erfolgId, async (tx) => {
      const a = await tx
        .select({ ownerClientId: assets.ownerClientId })
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1);
      const ev = await tx
        .select()
        .from(assetEvents)
        .where(and(eq(assetEvents.assetId, assetId), eq(assetEvents.type, 'owner_change')));
      return [a[0], ev] as const;
    });
    expect(assetRow?.ownerClientId).toBe(buyerId);
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({ from: sellerId, to: buyerId });

    // Guards: повторный complete и update проданной — BAD_REQUEST
    await expect(completeTradeInCmd(mkCmdCtx(), { id })).rejects.toThrowError(TRPCError);
    await expect(updateTradeInCmd(mkCmdCtx(), id, { notes: 'x' })).rejects.toThrowError(
      TRPCError,
    );
  });

  it('complete без покупателя — BAD_REQUEST', async () => {
    const { id } = await createTradeIn(getDb(), erfolgId, {
      name: `${TEST_PREFIX} БезПокупателя`,
      purchasePriceKopecks: 10_00n,
      assessedPriceKopecks: 20_00n,
      receivedAt: '2026-06-02',
    });
    await expect(completeTradeInCmd(mkCmdCtx(), { id })).rejects.toThrowError(TRPCError);
    expect((await getTradeInById(getDb(), erfolgId, id))?.status).toBe('received');
  });

  it('RLS: чужой тенант не видит позиции', async () => {
    const list = await listTradeIns(getDb(), demoId, { search: TEST_PREFIX });
    expect(list.items.length).toBe(0);
  });

  it('stats считает по статусам и деньгам', async () => {
    const s = await tradeInStats(getDb(), erfolgId);
    expect(s.sold).toBeGreaterThanOrEqual(1);
    expect(BigInt(s.soldRevenueKopecks)).toBeGreaterThanOrEqual(12_000_000n);
  });
});

describe('roadmap — CRUD-цикл', () => {
  it('create → list → update(progress, done) → archive', async () => {
    const { id } = await createGoal(getDb(), erfolgId, {
      quarter: 'Q3',
      year: 2026,
      title: `${TEST_PREFIX} Выручка 5 млн`,
      targetValue: 5_000_000,
      currentValue: 0,
      unit: '₽',
      category: 'revenue',
      priority: 'high',
    });

    const listed = await listGoals(getDb(), erfolgId, { year: 2026 });
    const mine = listed.find((g) => g.id === id);
    expect(mine?.quarter).toBe('Q3');
    expect(mine?.priority).toBe('high');

    const upd = await updateGoal(getDb(), erfolgId, id, { currentValue: 2_500_000, isDone: true });
    expect(upd?.currentValue).toBe(2_500_000);
    expect(upd?.isDone).toBe(true);

    expect(await archiveGoal(getDb(), erfolgId, id)).toBe(true);
    const after = await listGoals(getDb(), erfolgId, { year: 2026 });
    expect(after.some((g) => g.id === id)).toBe(false);

    // RLS: demo не видит цели erfolg
    const demoList = await listGoals(getDb(), demoId, { year: 2026 });
    expect(demoList.some((g) => g.title.startsWith(TEST_PREFIX))).toBe(false);
  });
});
