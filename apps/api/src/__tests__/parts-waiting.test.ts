/**
 * Фича №7 — «Лист ожидания запчастей».
 *
 * Покрытие:
 *   1. partsWaitingList отдаёт только активные ждущие деталь заявки, дольше всех — сверху,
 *      с daysWaiting (от blocked_since), заметкой и инженером.
 *   2. Закрытая заявка (даже с флагом) в список НЕ попадает.
 *   3. Снятие флага «Ждём запчасть» убирает заявку из списка.
 *   4. navBadges.partsWaiting растёт на новую ждущую заявку (staff); 0 для инженера.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket, partsWaitingList, setWaitingForPart } from '../modules/tickets/repository';
import { getNavBadgeCounts } from '../modules/dashboard/repository';

let erfolgId = '';
let primaryClientId = '';
let engineerId = '';

const TEST_PREFIX = 'TEST-PARTS-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  primaryClientId = c.id;
  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? usrs[0]!.id;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}
beforeEach(clearTestData);

async function makeTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId: primaryClientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  return id;
}

/** Отодвинуть blocked_since в прошлое, чтобы получить daysWaiting > 0. */
async function backdateBlockedSince(ticketId: string, daysAgo: number): Promise<void> {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(tickets).set({ blockedSince: d }).where(eq(tickets.id, ticketId)),
  );
}

describe('partsWaitingList', () => {
  it('только активные ждущие деталь, дольше всех — сверху, с днями и заметкой', async () => {
    const older = await makeTicket();
    await setWaitingForPart(getDb(), erfolgId, null, older, true, 'плата питания PSU-70');
    await backdateBlockedSince(older, 10);

    const newer = await makeTicket();
    await setWaitingForPart(getDb(), erfolgId, null, newer, true, 'уплотнитель камеры');
    await backdateBlockedSince(newer, 3);

    const notWaiting = await makeTicket(); // без флага

    const all = await partsWaitingList(getDb(), erfolgId);
    const ours = all.filter((x) => [older, newer, notWaiting].includes(x.id));

    expect(ours.map((x) => x.id)).toEqual([older, newer]); // порядок: 10 дней раньше 3
    const o = ours.find((x) => x.id === older)!;
    expect(o.daysWaiting).toBeGreaterThanOrEqual(9);
    expect(o.waitingForPartNote).toBe('плата питания PSU-70');
    const n = ours.find((x) => x.id === newer)!;
    expect(n.daysWaiting).toBeGreaterThanOrEqual(2);
    expect(n.daysWaiting).toBeLessThan(o.daysWaiting);
  });

  it('закрытая заявка с флагом в список не попадает', async () => {
    const id = await makeTicket();
    await setWaitingForPart(getDb(), erfolgId, null, id, true, 'деталь');
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(tickets).set({ status: 'closed', closedAt: new Date() }).where(eq(tickets.id, id)),
    );
    const all = await partsWaitingList(getDb(), erfolgId);
    expect(all.some((x) => x.id === id)).toBe(false);
  });

  it('снятие флага убирает заявку из списка', async () => {
    const id = await makeTicket();
    await setWaitingForPart(getDb(), erfolgId, null, id, true, 'деталь');
    expect((await partsWaitingList(getDb(), erfolgId)).some((x) => x.id === id)).toBe(true);
    await setWaitingForPart(getDb(), erfolgId, null, id, false, null);
    expect((await partsWaitingList(getDb(), erfolgId)).some((x) => x.id === id)).toBe(false);
  });
});

describe('navBadges.partsWaiting', () => {
  it('растёт на новую ждущую заявку (staff), 0 для инженера', async () => {
    const before = (await getNavBadgeCounts(getDb(), erfolgId, 'director', engineerId))
      .partsWaiting;

    const id = await makeTicket();
    await setWaitingForPart(getDb(), erfolgId, null, id, true, 'деталь');

    const after = (await getNavBadgeCounts(getDb(), erfolgId, 'director', engineerId)).partsWaiting;
    expect(after).toBe(before + 1);

    const eng = (await getNavBadgeCounts(getDb(), erfolgId, 'engineer', engineerId)).partsWaiting;
    expect(eng).toBe(0);
  });
});
