/**
 * Тесты модуля ticket-templates.
 *
 * 1. apply шаблона → создаёт work_order_lines корректно (типы, qty, цена в копейках).
 * 2. cross-tenant: шаблон demo не виден из erfolg, попытка apply → NOT_FOUND.
 * 3. archived шаблон не показывается в list (без includeArchived) и не применяется.
 * 4. apply → пишет audit-запись entityType='ticket_template_apply'.
 * 5. apply подставляет дефолты (priority/repairType) и пишет ticket_event-ы.
 * 6. apply на тот же ticket дважды дописывает строки (orderIdx инкрементируется).
 * 7. unique active name — два активных шаблона с одинаковым именем → CONFLICT.
 * 8. estimated_minutes из шаблона ставится только если тикет не запланирован.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  auditLogs,
  clients,
  getDb,
  ticketEvents,
  ticketTemplates,
  tickets,
  users,
  withTenantTx,
  workOrderLines,
  type TicketTemplateLine,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-TPL-';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
let demoClientId = '';
let dispatcherId = '';
let directorId = '';
let engineerId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const [c1] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [c2] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c1 || !c2) throw new Error('seed missing clients');
  erfolgClientId = c1.id;
  demoClientId = c2.id;

  const usrs = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id, role: users.role }).from(users),
  );
  const eng = usrs.find((u) => u.role === 'engineer');
  const disp = usrs.find((u) => u.role === 'dispatcher');
  const dir = usrs.find((u) => u.role === 'director');
  if (!eng || !disp) throw new Error('seed missing engineer/dispatcher');
  engineerId = eng.id;
  dispatcherId = disp.id;
  directorId = dir?.id ?? engineerId;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      // tickets → CASCADE удаляет связанные work_orders, work_order_lines, ticket_events.
      await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
      // Шаблоны (по prefix в имени).
      await tx.delete(ticketTemplates).where(like(ticketTemplates.name, `${TEST_PREFIX}%`));
      // Audit-записи о шаблонах и применении.
      await tx.delete(auditLogs).where(eq(auditLogs.entityType, 'ticket_template'));
      await tx.delete(auditLogs).where(eq(auditLogs.entityType, 'ticket_template_apply'));
    });
  }
}

beforeEach(clearTestData);

async function createBaseTicket(opts?: {
  tenantId?: string;
  clientId?: string;
  symptom?: string;
}): Promise<string> {
  const tid = opts?.tenantId ?? erfolgId;
  const cid = opts?.clientId ?? (tid === erfolgId ? erfolgClientId : demoClientId);
  const { id } = await createTicket(getDb(), tid, dispatcherId, {
    clientId: cid,
    symptom: opts?.symptom ?? `${TEST_PREFIX}base`,
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

const SAMPLE_LINES: TicketTemplateLine[] = [
  {
    lineType: 'work',
    name: 'Замена термопасты на CPU/GPU',
    unit: 'час',
    quantity: '1',
    unitPriceRub: 2500,
    inventoryItemId: null,
  },
  {
    lineType: 'part',
    name: 'Термопаста MX-4',
    unit: 'шт',
    quantity: '1',
    unitPriceRub: 800,
    inventoryItemId: null,
  },
];

describe('ticketTemplates.applyToTicket', () => {
  it('создаёт work_order_lines с корректными типами, qty и ценой в копейках', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}apply-basic` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));

    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}Замена термопасты`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });
    const result = await caller.ticketTemplates.applyToTicket({
      ticketId,
      templateId: tpl.id,
    });

    expect(result.workOrderId).toBeTruthy();
    expect(result.linesAdded).toBe(2);

    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          name: workOrderLines.name,
          lineType: workOrderLines.lineType,
          quantity: workOrderLines.quantity,
          unitPrice: workOrderLines.unitPriceKopecks,
          amount: workOrderLines.amountKopecks,
        })
        .from(workOrderLines)
        .where(eq(workOrderLines.workOrderId, result.workOrderId)),
    );
    expect(lines).toHaveLength(2);
    const work = lines.find((l) => l.lineType === 'work');
    const part = lines.find((l) => l.lineType === 'part');
    expect(work?.unitPrice).toBe(250000n); // 2500 руб = 250000 коп
    expect(work?.amount).toBe(250000n);
    expect(part?.unitPrice).toBe(80000n);
    expect(part?.name).toBe('Термопаста MX-4');
  });

  it('cross-tenant: шаблон demo нельзя применить к тикету erfolg → NOT_FOUND', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}cross-tenant` });
    const demoCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher', tenantId: demoId }));
    const tpl = await demoCaller.ticketTemplates.create({
      name: `${TEST_PREFIX}DemoOnly`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });

    const erfolgCaller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expect(
      erfolgCaller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('пишет audit-запись entityType=ticket_template_apply', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}audit` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}Audit`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });
    await caller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id });

    const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          after: auditLogs.after,
        })
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entityType, 'ticket_template_apply'), eq(auditLogs.entityId, ticketId)),
        ),
    );
    expect(rows.length).toBe(1);
    const after = rows[0]?.after as Record<string, unknown>;
    expect(after.templateId).toBe(tpl.id);
    expect(after.linesAdded).toBe(2);
  });

  it('подставляет defaultPriority/defaultRepairType и создаёт ticket_event-ы', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}defaults` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}HighWarranty`,
      description: 'Гарантийная высокоприоритетная',
      defaultRepairType: 'warranty',
      defaultPriority: 'high',
      defaultEstimatedMinutes: 90,
      lines: [],
    });
    const result = await caller.ticketTemplates.applyToTicket({
      ticketId,
      templateId: tpl.id,
    });
    expect(result.appliedDefaults.repairType).toBe(true);
    expect(result.appliedDefaults.priority).toBe(true);
    expect(result.appliedDefaults.estimatedMinutes).toBe(true);

    const [t] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({
          priority: tickets.priority,
          repairType: tickets.repairType,
          estimated: tickets.estimatedMinutes,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId)),
    );
    expect(t?.priority).toBe('high');
    expect(t?.repairType).toBe('warranty');
    expect(t?.estimated).toBe(90);

    // ticket_event на priority_change должен появиться (был normal, стал high).
    const events = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ type: ticketEvents.type })
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, ticketId)),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('priority_change');
  });
});

describe('ticketTemplates.list/archive', () => {
  it('archived шаблон не показывается в list без includeArchived', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}ToArchive`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });
    await caller.ticketTemplates.archive({ id: tpl.id });

    const visible = await caller.ticketTemplates.list({});
    expect(visible.find((t) => t.id === tpl.id)).toBeUndefined();

    const all = await caller.ticketTemplates.list({ includeArchived: true });
    const archived = all.find((t) => t.id === tpl.id);
    expect(archived).toBeDefined();
    expect(archived?.archivedAt).not.toBeNull();
  });

  it('apply архивного шаблона → CONFLICT', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}arch-apply` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}ArchApply`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });
    await caller.ticketTemplates.archive({ id: tpl.id });

    await expect(
      caller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('ticketTemplates: уникальность имени активных шаблонов', () => {
  it('два активных шаблона с одинаковым именем (case-insensitive) → CONFLICT', async () => {
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}UNIQUE`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: [],
    });
    await expect(
      caller.ticketTemplates.create({
        name: `${TEST_PREFIX}unique`,
        description: null,
        defaultRepairType: null,
        defaultPriority: null,
        defaultEstimatedMinutes: null,
        lines: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('ticketTemplates.applyToTicket повторно', () => {
  it('повторное применение дописывает строки в тот же work_order', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}reapply` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}Reapply`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: null,
      lines: SAMPLE_LINES,
    });

    const r1 = await caller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id });
    const r2 = await caller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id });
    expect(r1.workOrderId).toBe(r2.workOrderId);

    const lines = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: workOrderLines.id })
        .from(workOrderLines)
        .where(eq(workOrderLines.workOrderId, r1.workOrderId)),
    );
    expect(lines.length).toBe(SAMPLE_LINES.length * 2);
  });
});

describe('ticketTemplates.applyToTicket: estimatedMinutes защита расписания', () => {
  it('не перезаписывает estimatedMinutes если тикет уже запланирован', async () => {
    const ticketId = await createBaseTicket({ symptom: `${TEST_PREFIX}schedule-keep` });
    const caller = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    // Сначала ставим в график на 30 мин.
    const start = new Date(Date.now() + 24 * 3600 * 1000);
    await caller.tickets.schedule({
      ticketId,
      engineerId,
      scheduledStartAt: start,
      estimatedMinutes: 30,
    });
    // Шаблон с другой оценкой.
    const tpl = await caller.ticketTemplates.create({
      name: `${TEST_PREFIX}Estimate60`,
      description: null,
      defaultRepairType: null,
      defaultPriority: null,
      defaultEstimatedMinutes: 60,
      lines: [],
    });
    const res = await caller.ticketTemplates.applyToTicket({ ticketId, templateId: tpl.id });
    expect(res.appliedDefaults.estimatedMinutes).toBe(false);

    const [t] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ m: tickets.estimatedMinutes }).from(tickets).where(eq(tickets.id, ticketId)),
    );
    expect(t?.m).toBe(30); // не перезаписано
  });
});
