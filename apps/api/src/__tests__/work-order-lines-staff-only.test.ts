/**
 * Строки наряда и цены — только менеджер/директор. У инженера один путь,
 * создающий строку, — «Списать со склада».
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (2026-08-08, подтверждено 2026-08-10): «цену ставит
 * менеджер в десктопной CRM, строки наряда заводит тоже он». Причина не
 * косметика: себестоимость труда = процент инженера от цены строки (#88),
 * то есть, набирая цену, инженер одним числом выставлял счёт клиенту и
 * назначал себе сделку. #122 закрыл это на мобильном экране, но API
 * по-прежнему принимал от инженера строки с любой ценой и исполнителем —
 * а десктопный редактор доступен ему штатной кнопкой «Открыть полную версию».
 *
 * Что инженеру ОСТАЁТСЯ:
 *  - «Списать со склада»: создание строки-запчасти с нулевой ценой (цену
 *    продажи потом ставит менеджер, себестоимость приходит из партий);
 *  - текстовые поля наряда (диагноз, «что было и что сделал», рекомендации);
 *  - возврат на склад (returnFromWorkOrder — строки не трогает).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { getDb, clients, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-LINES-STAFF-';

let erfolgId = '';
let clientId = '';
let engineerId = '';
let dispatcherId = '';

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
  const engineer = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!engineer || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = engineer.id;
  dispatcherId = disp.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: { role: 'dispatcher' | 'engineer' }): Context {
  const userId = opts.role === 'engineer' ? engineerId : dispatcherId;
  const session: SessionData = {
    tenantId: erfolgId,
    userId,
    username: `${opts.role}-test`,
    role: opts.role,
    fullName: `Test ${opts.role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'erfolg',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

/** Своя заявка инженера с созданным нарядом. */
async function makeMyTicketWithWorkOrder(): Promise<string> {
  const { id } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
    assignedEngineerId: engineerId,
  });
  const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
  await caller.workOrders.ensure({ ticketId: id });
  return id;
}

describe('инженер и строки наряда (своя заявка)', () => {
  it('строка работ с ценой — отказ: цену ставит менеджер', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.upsertLine({
        ticketId,
        line: {
          lineType: 'work',
          name: 'Замена платы',
          unit: 'шт',
          quantity: '1',
          unitPriceRub: 18000,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('запчасть с ненулевой ценой — отказ', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.upsertLine({
        ticketId,
        line: { lineType: 'part', name: 'Плата', unit: 'шт', quantity: '1', unitPriceRub: 500 },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('назначить себя исполнителем строки — отказ: это сделка', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.upsertLine({
        ticketId,
        line: {
          lineType: 'part',
          name: 'Плата',
          unit: 'шт',
          quantity: '1',
          unitPriceRub: 0,
          engineerId,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('путь «Списать со склада» жив: запчасть с нулевой ценой создаётся', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    const created = await caller.workOrders.upsertLine({
      ticketId,
      line: { lineType: 'part', name: 'Плата питания', unit: 'шт', quantity: '1', unitPriceRub: 0 },
    });
    expect(created.id).toBeTruthy();
  });

  it('правка существующей строки — отказ, даже своей нулевой', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    const created = await caller.workOrders.upsertLine({
      ticketId,
      line: { lineType: 'part', name: 'Плата', unit: 'шт', quantity: '1', unitPriceRub: 0 },
    });

    await expect(
      caller.workOrders.upsertLine({
        ticketId,
        line: {
          id: created.id,
          lineType: 'part',
          name: 'Плата',
          unit: 'шт',
          quantity: '2',
          unitPriceRub: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('удаление строки — отказ', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const dispatcher = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const line = await dispatcher.workOrders.upsertLine({
      ticketId,
      line: { lineType: 'work', name: 'Диагностика', unit: 'шт', quantity: '1', unitPriceRub: 500 },
    });

    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expect(caller.workOrders.deleteLine({ ticketId, lineId: line.id })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  });

  it('отказ объясняет причину по-человечески', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.upsertLine({
        ticketId,
        line: { lineType: 'work', name: 'Работа', unit: 'шт', quantity: '1', unitPriceRub: 100 },
      }),
    ).rejects.toThrow(/менеджер|директор/);
  });
});

describe('шапка наряда', () => {
  it('текстовые поля инженеру можно', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.updateHeader({
        ticketId,
        patch: { diagnosis: 'Сгорел предохранитель', engineerNotes: 'заменил, проверил' },
      }),
    ).resolves.not.toThrow();
  });

  it('назначить исполнителя наряда инженеру нельзя', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(
      caller.workOrders.updateHeader({ ticketId, patch: { engineerId } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('менеджер и директор не ограничены', () => {
  it('диспетчер заводит строку работ с ценой и исполнителем', async () => {
    const ticketId = await makeMyTicketWithWorkOrder();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const created = await caller.workOrders.upsertLine({
      ticketId,
      line: {
        lineType: 'work',
        name: 'Ремонт клапана',
        unit: 'шт',
        quantity: '1',
        unitPriceRub: 12000,
        engineerId,
      },
    });
    expect(created.id).toBeTruthy();

    // И правит, и удаляет.
    await caller.workOrders.upsertLine({
      ticketId,
      line: {
        id: created.id,
        lineType: 'work',
        name: 'Ремонт клапана',
        unit: 'шт',
        quantity: '1',
        unitPriceRub: 15000,
      },
    });
    await expect(
      caller.workOrders.deleteLine({ ticketId, lineId: created.id }),
    ).resolves.not.toThrow();
  });
});
