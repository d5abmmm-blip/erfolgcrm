/**
 * Несколько инженеров на одну заявку (запрос владельца 2026-07-23:
 * «назначаю инженера — можно выбрать только одного, нужно несколько»).
 *
 * УСТРОЙСТВО НАМЕРЕННО АСИММЕТРИЧНОЕ: ОТВЕТСТВЕННЫЙ остаётся в
 * `tickets.assigned_engineer_id`, ПОМОЩНИКИ лежат в новой таблице `ticket_engineers`.
 * Так график, напоминания и отчёты загрузки (около 75 мест в коде) продолжают
 * работать без переделки, а «кто ещё работает по заявке» стало списком.
 *
 * Что здесь проверяется — ровно то, ради чего всё затевалось:
 *   1. помощника можно назначить и снять, список не двоится;
 *   2. помощник ВИДИТ заявку у себя (список «Мои заявки» и «Мой день»);
 *   3. помощник МОЖЕТ в ней работать — реагировать кнопкой и печатать документы
 *      (иначе он видел бы заявку, но упирался в «это не ваша заявка»);
 *   4. ответственный и посторонний инженер ведут себя как раньше.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, ticketEngineers, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createTicket,
  listTicketEngineers,
  listTickets,
  setTicketEngineers,
} from '../modules/tickets/repository';
import {
  assertEngineerOwnsTicket,
  engineerReactCmd,
  myTicketsQuery,
  setTicketEngineersCmd,
} from '../modules/tickets/service';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TESTMULTIENG-';

let erfolgId = '';
let clientId = '';
let mainEngineerId = '';
let helperEngineerId = '';
let strangerEngineerId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  clientId = c.id;

  // Берём ТРЁХ пользователей seed вместо того, чтобы заводить своих.
  //
  // ⚠️ ДВЕ ПРИЧИНЫ, обе стоили времени:
  // 1. vitest гоняет файлы ПАРАЛЛЕЛЬНО на общей базе, а соседний набор (cross-tenant)
  //    проверяет, что в тенанте ровно 3 пользователя. Любой созданный здесь инженер
  //    ломал его по гонке — даже с уборкой в afterAll.
  // 2. Выдуманные id тоже не годятся: у `ticket_events.user_id` есть НАСТОЯЩИЙ внешний
  //    ключ на users, и реакция помощника падала на нём.
  // Роль в сессии подставляем сами — проверяемая механика («помощник тот, кто в списке»)
  // от штатной должности человека не зависит.
  const seedUsers = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = seedUsers.find((u) => u.role === 'engineer');
  const disp = seedUsers.find((u) => u.role === 'dispatcher');
  const dir = seedUsers.find((u) => u.role === 'director');
  if (!eng || !disp || !dir) throw new Error('seed: нужны engineer, dispatcher, director');
  mainEngineerId = eng.id;
  helperEngineerId = disp.id;
  strangerEngineerId = dir.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

/** Заявка с ответственным инженером. */
async function makeTicket(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}вдвоём`,
    assignedEngineerId: mainEngineerId,
  });
  return id;
}

function makeCtx(userId: string, role: 'engineer' | 'dispatcher' = 'engineer') {
  const tenant: ResolvedTenant = {
    id: erfolgId,
    subdomain: 'erfolg',
    displayName: 'erfolg',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: 'test',
    role,
    fullName: 'Тест',
    expiresAt: Date.now() + 60_000,
  };
  return { db: getDb(), tenant, session, audit: { ip: null, userAgent: null } };
}

describe('назначение помощников', () => {
  it('можно назначить двоих помощников и прочитать список', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [
      helperEngineerId,
      strangerEngineerId,
    ]);
    const list = await listTicketEngineers(getDb(), erfolgId, ticketId);
    expect(list.map((e) => e.userId).sort()).toEqual(
      [helperEngineerId, strangerEngineerId].sort(),
    );
  });

  it('повторное назначение того же человека не двоит строки', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);
    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(ticketEngineers).where(eq(ticketEngineers.ticketId, ticketId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('ОТВЕТСТВЕННЫЙ не попадает в помощники — иначе он посчитался бы дважды', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [
      mainEngineerId,
      helperEngineerId,
    ]);
    const list = await listTicketEngineers(getDb(), erfolgId, ticketId);
    expect(list.map((e) => e.userId)).toEqual([helperEngineerId]);
  });

  it('в помощники нельзя вписать чужой id — команда проверяет тенант', async () => {
    // Настоящий инженер проходит, выдуманный — нет. Иначе через API можно было бы
    // приписать к заявке кого угодно и открыть ему данные клиента.
    const ticketId = await makeTicket();
    await expect(
      setTicketEngineersCmd(makeCtx(mainEngineerId, 'dispatcher'), ticketId, [randomUUID()]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('пустой список снимает всех помощников', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);
    await setTicketEngineers(getDb(), erfolgId, ticketId, []);
    const list = await listTicketEngineers(getDb(), erfolgId, ticketId);
    expect(list).toHaveLength(0);
  });
});

describe('помощник видит заявку у себя', () => {
  it('заявка попадает в список «Мои заявки» помощника', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    const mine = await listTickets(getDb(), erfolgId, { engineerId: helperEngineerId });
    expect(mine.items.some((t) => t.id === ticketId)).toBe(true);
  });

  it('заявка остаётся и у ответственного — помощники его не вытесняют', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    const mine = await listTickets(getDb(), erfolgId, { engineerId: mainEngineerId });
    expect(mine.items.some((t) => t.id === ticketId)).toBe(true);
  });

  it('посторонний инженер заявку у себя НЕ видит', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    const notMine = await listTickets(getDb(), erfolgId, { engineerId: strangerEngineerId });
    expect(notMine.items.some((t) => t.id === ticketId)).toBe(false);
  });

  it('заявка попадает в «Мой день» помощника', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    const myDay = await myTicketsQuery(
      getDb(),
      { id: erfolgId } as ResolvedTenant,
      helperEngineerId,
    );
    expect(myDay.some((t) => t.id === ticketId)).toBe(true);
  });
});

describe('помощник может РАБОТАТЬ в заявке, а не только смотреть', () => {
  it('помощник реагирует кнопкой «взял в работу»', async () => {
    // Без этого помощник видел бы заявку в списке и упирался в «Это не ваша заявка».
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    const res = await engineerReactCmd(makeCtx(helperEngineerId), ticketId, 'inwork');
    expect(res.kind).toBe('inwork');
    expect(res.message).toBeTruthy();
  });

  it('посторонний инженер реагировать НЕ может', async () => {
    const ticketId = await makeTicket();
    await setTicketEngineers(getDb(), erfolgId, ticketId, [helperEngineerId]);

    await expect(
      engineerReactCmd(makeCtx(strangerEngineerId), ticketId, 'inwork'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('помощник допущен к документам заявки', async () => {
    // Акт печатает тот, кто выполнял ремонт. Помощник ремонт выполнял.
    expect(() =>
      assertEngineerOwnsTicket(
        { role: 'engineer', userId: helperEngineerId },
        { assignedEngineerId: mainEngineerId, helperEngineerIds: [helperEngineerId] },
      ),
    ).not.toThrow();
  });

  it('посторонний к документам НЕ допущен', () => {
    expect(() =>
      assertEngineerOwnsTicket(
        { role: 'engineer', userId: strangerEngineerId },
        { assignedEngineerId: mainEngineerId, helperEngineerIds: [helperEngineerId] },
      ),
    ).toThrow();
  });

  it('ответственный допущен, как и раньше', () => {
    expect(() =>
      assertEngineerOwnsTicket(
        { role: 'engineer', userId: mainEngineerId },
        { assignedEngineerId: mainEngineerId, helperEngineerIds: [] },
      ),
    ).not.toThrow();
  });
});
