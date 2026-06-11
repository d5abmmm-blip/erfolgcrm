/**
 * Stage 11 — backend графика загрузки инженеров.
 *
 * Тесты:
 *   1. tickets.schedule ставит engineer + время + audit запись (action='schedule_change').
 *   2. tickets.unschedule снимает время, engineerId остаётся.
 *   3. tickets.weeklySchedule возвращает только тикеты в окне [weekStart, weekStart+7d).
 *   4. tickets.myWeeklySchedule возвращает только тикеты текущего инженера.
 *   5. Cross-tenant: тикеты другого tenant не видны через RLS.
 *   6. CHECK constraint срабатывает: попытка scheduledEnd < scheduledStart → ошибка БД.
 *   7. tickets.list с scheduled=false отфильтровывает запланированные.
 *   8. repoSchedule бросает TicketNotFoundError для несуществующего ticketId.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  auditLogs,
  clients,
  getDb,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-SCH-';

let erfolgId = '';
let demoId = '';
let primaryClientId = '';
let secondaryClientIdDemo = '';
let engineerId = '';
let engineer2Id = '';
let dispatcherId = '';
let directorId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client (erfolg)');
  primaryClientId = c.id;
  const [demoClient] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!demoClient) throw new Error('seed missing client (demo)');
  secondaryClientIdDemo = demoClient.id;

  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users),
  );
  const engineers = usrs.filter((u) => u.role === 'engineer');
  if (engineers.length === 0) throw new Error('seed missing engineer');
  engineerId = engineers[0]!.id;
  engineer2Id = engineers[1]?.id ?? engineers[0]!.id;
  const disp = usrs.find((u) => u.role === 'dispatcher');
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
  // Директор может быть удалён предыдущими тестами — fallback на engineer.id
  // (RBAC смотрит только на role в SessionData).
  const dir = usrs.find((u) => u.role === 'director');
  directorId = dir?.id ?? engineerId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      // audit_logs по entityType='ticket' могут попадать сюда — фильтруем
      // по action='schedule_change' чтобы не задеть другие тесты.
      await tx
        .delete(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, 'ticket'),
            eq(auditLogs.action, 'schedule_change'),
          ),
        );
    });
  }
}

beforeEach(clearTestData);

async function createBaseTicket(opts?: { tenantId?: string; clientId?: string }): Promise<string> {
  const tid = opts?.tenantId ?? erfolgId;
  const cid = opts?.clientId ?? primaryClientId;
  const { id } = await createTicket(getDb(), tid, null, {
    clientId: cid,
    symptom: `${TEST_PREFIX}base`,
  });
  return id;
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: {
  role: 'director' | 'dispatcher' | 'engineer';
  userId?: string;
  tenantId?: string;
}): Context {
  const tid = opts.tenantId ?? erfolgId;
  const userId =
    opts.userId ??
    (opts.role === 'director'
      ? directorId
      : opts.role === 'dispatcher'
        ? dispatcherId
        : engineerId);
  const session: SessionData = {
    tenantId: tid,
    userId,
    username: `${opts.role}-test`,
    role: opts.role,
    fullName: `Test ${opts.role}`,
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: tid,
      subdomain: tid === erfolgId ? 'erfolg' : 'demo',
      displayName: tid === erfolgId ? 'erfolg' : 'demo',
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

/** Понедельник 00:00 текущей недели в локальной TZ (для weeklySchedule окна). */
function thisMonday(): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

describe('Stage 11: tickets.schedule', () => {
  it('ставит engineer + scheduled_start_at + estimated_minutes и пишет audit (schedule_change)', async () => {
    const ticketId = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const start = new Date(thisMonday().getTime() + 9 * 3600 * 1000); // понед. 09:00
    const end = new Date(start.getTime() + 90 * 60 * 1000); // +90 мин

    const result = await caller.tickets.schedule({
      ticketId,
      engineerId,
      scheduledStartAt: start,
      scheduledEndAt: end,
      estimatedMinutes: 90,
    });
    expect(result.ticketId).toBe(ticketId);
    expect(result.engineerId).toBe(engineerId);
    expect(result.scheduledStartAt.getTime()).toBe(start.getTime());

    // Поля в БД
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          eng: tickets.assignedEngineerId,
          start: tickets.scheduledStartAt,
          end: tickets.scheduledEndAt,
          minutes: tickets.estimatedMinutes,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(row?.eng).toBe(engineerId);
    expect(row?.start?.getTime()).toBe(start.getTime());
    expect(row?.end?.getTime()).toBe(end.getTime());
    expect(row?.minutes).toBe(90);

    // Audit
    const auditRows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          before: auditLogs.before,
          after: auditLogs.after,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'schedule_change'),
            eq(auditLogs.entityType, 'ticket'),
            eq(auditLogs.entityId, ticketId),
          ),
        ),
    );
    expect(auditRows.length).toBe(1);
    const after = auditRows[0]?.after as Record<string, unknown> | null;
    expect(after?.engineerId).toBe(engineerId);
    expect(after?.estimatedMinutes).toBe(90);
  });
});

describe('Stage 11: tickets.unschedule', () => {
  it('снимает расписание; assigned_engineer_id остаётся прежним', async () => {
    const ticketId = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const start = new Date(thisMonday().getTime() + 10 * 3600 * 1000);
    await caller.tickets.schedule({
      ticketId,
      engineerId,
      scheduledStartAt: start,
      estimatedMinutes: 60,
    });

    await caller.tickets.unschedule({ ticketId });

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          eng: tickets.assignedEngineerId,
          start: tickets.scheduledStartAt,
          end: tickets.scheduledEndAt,
          minutes: tickets.estimatedMinutes,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(row?.eng).toBe(engineerId); // engineer остался
    expect(row?.start).toBeNull();
    expect(row?.end).toBeNull();
    expect(row?.minutes).toBeNull();
  });
});

describe('Stage 11: tickets.weeklySchedule', () => {
  it('возвращает только тикеты в окне [weekStart, weekStart+7d)', async () => {
    const inWindowId = await createBaseTicket();
    const outOfWindowId = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const monday = thisMonday();
    const inWindow = new Date(monday.getTime() + 2 * 24 * 3600 * 1000); // среда
    const outOfWindow = new Date(monday.getTime() + 8 * 24 * 3600 * 1000); // следующая неделя

    await caller.tickets.schedule({
      ticketId: inWindowId,
      engineerId,
      scheduledStartAt: inWindow,
      estimatedMinutes: 60,
    });
    await caller.tickets.schedule({
      ticketId: outOfWindowId,
      engineerId,
      scheduledStartAt: outOfWindow,
      estimatedMinutes: 60,
    });

    const list = await caller.tickets.weeklySchedule({ weekStart: monday });
    const ids = list.map((t) => t.id);
    expect(ids).toContain(inWindowId);
    expect(ids).not.toContain(outOfWindowId);
  });
});

describe('Stage 11: tickets.myWeeklySchedule', () => {
  it('возвращает только тикеты текущего инженера', async () => {
    const t1 = await createBaseTicket();
    const t2 = await createBaseTicket();
    const dispatcher = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const monday = thisMonday();
    const start1 = new Date(monday.getTime() + 11 * 3600 * 1000);
    const start2 = new Date(monday.getTime() + 13 * 3600 * 1000);

    // t1 → engineerId, t2 → engineer2Id (если есть второй; иначе тот же — тогда оба видны)
    await dispatcher.tickets.schedule({
      ticketId: t1,
      engineerId,
      scheduledStartAt: start1,
      estimatedMinutes: 60,
    });
    await dispatcher.tickets.schedule({
      ticketId: t2,
      engineerId: engineer2Id,
      scheduledStartAt: start2,
      estimatedMinutes: 60,
    });

    const myCaller = appRouter.createCaller(
      makeCtx({ role: 'engineer', userId: engineerId }),
    );
    const myList = await myCaller.tickets.myWeeklySchedule({ weekStart: monday });
    const myIds = myList.map((t) => t.id);
    expect(myIds).toContain(t1);
    if (engineerId !== engineer2Id) {
      expect(myIds).not.toContain(t2);
    }
  });
});

describe('Stage 11: cross-tenant защита', () => {
  it('тикеты demo не видны в weeklySchedule erfolg (RLS)', async () => {
    const erfolgTicket = await createBaseTicket();
    const demoTicket = await createBaseTicket({
      tenantId: demoId,
      clientId: secondaryClientIdDemo,
    });
    const monday = thisMonday();
    const start = new Date(monday.getTime() + 9 * 3600 * 1000);

    // Schedule erfolg-ticket через erfolg-dispatcher.
    const erfolgCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await erfolgCaller.tickets.schedule({
      ticketId: erfolgTicket,
      engineerId,
      scheduledStartAt: start,
      estimatedMinutes: 30,
    });

    // Schedule demo-ticket напрямую через withTenantTx (нет seed-инженера в demo, не нужен audit).
    await withTenantTx(getDb(), demoId, (tx) =>
      tx
        .update(tickets)
        .set({ scheduledStartAt: start, estimatedMinutes: 30 })
        .where(eq(tickets.id, demoTicket)),
    );

    const erfolgList = await erfolgCaller.tickets.weeklySchedule({ weekStart: monday });
    const ids = erfolgList.map((t) => t.id);
    expect(ids).toContain(erfolgTicket);
    expect(ids).not.toContain(demoTicket);
  });
});

describe('Stage 11: CHECK constraint tickets_schedule_consistency', () => {
  it('scheduledEndAt < scheduledStartAt → DB error', async () => {
    const ticketId = await createBaseTicket();
    const start = new Date(thisMonday().getTime() + 14 * 3600 * 1000);
    const end = new Date(start.getTime() - 30 * 60 * 1000); // на 30 мин раньше

    await expect(
      withTenantTx(getDb(), erfolgId, (tx) =>
        tx
          .update(tickets)
          .set({ scheduledStartAt: start, scheduledEndAt: end })
          .where(eq(tickets.id, ticketId)),
      ),
    ).rejects.toThrow(/tickets_schedule_consistency/i);
  });
});

describe('Stage 11: tickets.list scheduled-фильтр', () => {
  it('scheduled=false показывает только незапланированные', async () => {
    const scheduledId = await createBaseTicket();
    const unscheduledId = await createBaseTicket();
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const start = new Date(thisMonday().getTime() + 9 * 3600 * 1000);
    await caller.tickets.schedule({
      ticketId: scheduledId,
      engineerId,
      scheduledStartAt: start,
      estimatedMinutes: 60,
    });

    const onlyUnscheduled = await caller.tickets.list({
      scheduled: false,
      pageSize: 100,
    });
    const ids = onlyUnscheduled.items.map((t) => t.id);
    expect(ids).toContain(unscheduledId);
    expect(ids).not.toContain(scheduledId);
  });
});

describe('Stage 11: schedule на несуществующий ticketId', () => {
  it('бросает NOT_FOUND через TRPCError', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const start = new Date(thisMonday().getTime() + 9 * 3600 * 1000);
    await expect(
      caller.tickets.schedule({
        ticketId: fakeId,
        engineerId,
        scheduledStartAt: start,
        estimatedMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
