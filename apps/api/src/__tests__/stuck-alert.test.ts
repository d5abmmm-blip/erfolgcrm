/**
 * Воркер алертов о застревании — processStuckAlertTick.
 *
 * Тесты:
 *   1. Тик находит «красную» (застрявшую) заявку и алертит по ней.
 *   2. Повторный тик пропускает её по дедупу (Redis SET NX).
 *
 * Push доставку не проверяем (VAPID в тестах нет) — проверяем логику отбора и дедупа.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { getRedis } from '../lib/redis';
import { createTicket, setBlockedReason } from '../modules/tickets/repository';
import { processStuckAlertTick } from '../workers/stuck-alert';

const TEST_PREFIX = 'TEST-STUCK-';

let erfolgId = '';
let clientId = '';
let ticketId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  clientId = c!.id;
  // Убедимся, что есть staff (директор/диспетчер) — иначе алерт не шлётся.
  const staff = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  if (!staff.some((u) => u.role === 'director' || u.role === 'dispatcher')) {
    throw new Error('seed missing staff');
  }

  // Создаём заявку и делаем её «красной»: причина простоя + blocked_since 10 дней назад.
  const created = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}stuck`,
  });
  ticketId = created.id;
  await setBlockedReason(getDb(), erfolgId, null, ticketId, 'waiting_management_decision', null);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.update(tickets).set({ blockedSince: tenDaysAgo }).where(eq(tickets.id, ticketId)),
  );
  // Чистим возможный старый дедуп-ключ (детерминизм между прогонами).
  await getRedis().del(`erfolg:stuck-alert:${erfolgId}:${ticketId}`);
});

afterAll(async () => {
  await getRedis().del(`erfolg:stuck-alert:${erfolgId}:${ticketId}`);
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`)),
  );
});

describe('stuck-alert: тик', () => {
  it('находит застрявшую заявку и алертит, повтор — дедуп', async () => {
    const first = await processStuckAlertTick();
    expect(first.stuck).toBeGreaterThanOrEqual(1);
    expect(first.alerted).toBeGreaterThanOrEqual(1);

    const second = await processStuckAlertTick();
    // Наша заявка уже алерчена → во втором тике она пропущена по дедупу.
    expect(second.skippedDedup).toBeGreaterThanOrEqual(1);
  });
});
