/**
 * Cross-tenant security tests для tickets / ticket_events / work_orders /
 * work_order_lines / tenant_counters.
 *
 * Проверяем: RLS блокирует чтение/запись/удаление чужих записей,
 * INSERT с подменой tenant_id отвергается, попытка создать ticket
 * с client_id чужого tenant'а → BAD_REQUEST через tRPC слой.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  clients,
  getDb,
  tenantCounters,
  ticketEvents,
  tickets,
  withTenantTx,
  withoutTenantTx,
  workOrderLines,
  workOrders,
} from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import { ticketsRouter } from '../modules/tickets';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

describe('RLS — tickets/* без tenant_id', () => {
  it('tickets: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(tickets));
    expect(rows.length).toBe(0);
  });
  it('ticket_events: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(ticketEvents));
    expect(rows.length).toBe(0);
  });
  it('work_orders: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(workOrders));
    expect(rows.length).toBe(0);
  });
  it('work_order_lines: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(workOrderLines));
    expect(rows.length).toBe(0);
  });
  it('tenant_counters: 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(tenantCounters));
    expect(rows.length).toBe(0);
  });
});

describe('RLS — tickets изолированы по tenant', () => {
  it('erfolg видит свои tickets, не demo', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(tickets));
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) expect(t.tenantId).toBe(erfolgId);
  });

  it('UPDATE чужого ticket → 0 affected', async () => {
    const [erfolgTicket] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).limit(1),
    );
    if (!erfolgTicket) throw new Error('seed missing');
    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .update(tickets)
        .set({ priority: 'urgent' })
        .where(eq(tickets.id, erfolgTicket.id))
        .returning({ id: tickets.id }),
    );
    expect(result.length).toBe(0);
  });

  it('DELETE чужого work_order → 0 affected', async () => {
    const [erfolgWo] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(workOrders).limit(1),
    );
    if (!erfolgWo) throw new Error('seed missing work_order — расширь seed');
    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .delete(workOrders)
        .where(eq(workOrders.id, erfolgWo.id))
        .returning({ id: workOrders.id }),
    );
    expect(result.length).toBe(0);

    const [stillThere] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(workOrders).where(eq(workOrders.id, erfolgWo.id)),
    );
    expect(stillThere?.id).toBe(erfolgWo.id);
  });

  it('INSERT в tickets с подменой tenant_id → throws', async () => {
    const [erfolgClient] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(clients).limit(1),
    );
    if (!erfolgClient) throw new Error('seed missing client');
    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(tickets).values({
          tenantId: erfolgId,
          ticketNumber: 'T-9999-CROSS01',
          barcode: 'TCROSS01-DEMO',
          clientId: erfolgClient.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('INSERT в ticket_events с подмененным ticket_id из чужого tenant → throws', async () => {
    const [erfolgTicket] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(tickets).limit(1),
    );
    if (!erfolgTicket) throw new Error('seed missing');
    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(ticketEvents).values({
          tenantId: erfolgId,
          ticketId: erfolgTicket.id,
          type: 'note',
          payload: { comment: 'inj' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('Service: создание ticket с client_id чужого tenant — отвергается', () => {
  it('createTicket с demo-client под erfolg-сессией → BAD_REQUEST', async () => {
    const [demoClient] = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(clients).limit(1),
    );
    if (!demoClient) throw new Error('seed missing demo client');

    const caller = ticketsRouter.createCaller({
      db: getDb(),
      tenant: {
        id: erfolgId,
        subdomain: 'erfolg',
        displayName: 'erfolg',
        status: 'active',
        timezone: 'Europe/Moscow',
        kmsKeyId: null,
      },
      session: {
        tenantId: erfolgId,
        userId: '00000000-0000-0000-0000-000000000000',
        username: 'director',
        role: 'director',
        fullName: 'Test',
        expiresAt: Date.now() + 3600_000,
      },
      clientUser: null,
      ip: '127.0.0.1',
      userAgent: 'test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res: {} as any,
    });

    await expect(caller.create({ clientId: demoClient.id })).rejects.toBeInstanceOf(TRPCError);
  });
});
