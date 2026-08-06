/**
 * КП с версиями (перенос из v1) — серверное версионирование + approve-инварианты + RLS.
 *
 * Проверяем:
 *   1. version назначается сервером: 1, 2, 3… в рамках заявки.
 *   2. approve атомарно демотирует прочие approved-версии в rejected (unique-approved).
 *   3. Guard: архив утверждённой версии запрещён (service), не-утверждённой — работает.
 *   4. RLS: чужой тенант не видит версии КП.
 *   5. Smoke отчётов: revenueByClient/slaCompliance/leadsFunnel/receivables отвечают.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { TRPCError } from '@trpc/server';
import { ensureSeed } from './setup';
import {
  approveKp,
  archiveKp,
  createKp,
  getKpById,
  listByTicket,
} from '../modules/kp-versions/repository';
import { archiveKpCmd } from '../modules/kp-versions/service';
import {
  engineerPerformance,
  leadsFunnel,
  receivables,
  revenueByClient,
  slaCompliance,
} from '../modules/reports/repository';
import type { CmdCtx } from '../../src/trpc/helpers';

let erfolgId = '';
let demoId = '';
let ticketId = '';
let userId = '';

const STAMP = Date.now();
const TEST_PREFIX = `TEST-KP-${STAMP}`;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  // Тестовая заявка (минимальный набор NOT NULL: number, barcode, client).
  ({ ticketId, userId } = await withTenantTx(getDb(), erfolgId, async (tx) => {
    const u = await tx.select({ id: users.id }).from(users).limit(1);
    const c = await tx
      .insert(clients)
      .values({
        tenantId: erfolgId,
        type: 'legal',
        subtype: 'commercial',
        displayName: `${TEST_PREFIX}-Client`,
        status: 'active',
      })
      .returning({ id: clients.id });
    const t = await tx
      .insert(tickets)
      .values({
        tenantId: erfolgId,
        ticketNumber: `${TEST_PREFIX}-1`,
        barcode: `${TEST_PREFIX}-BC`,
        clientId: c[0]!.id,
      })
      .returning({ id: tickets.id });
    return { ticketId: t[0]!.id, userId: u[0]!.id };
  }));
});

// Не оставляем мусор в dev-БД: удаление заявки каскадно сносит её версии КП.
afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    if (ticketId) await tx.delete(tickets).where(eq(tickets.id, ticketId));
    await tx.delete(clients).where(eq(clients.displayName, `${TEST_PREFIX}-Client`));
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

const mkKp = (description: string) =>
  createKp(getDb(), erfolgId, {
    ticketId,
    worksAmountKopecks: 100_00n,
    partsAmountKopecks: 50_00n,
    description,
    createdByUserId: userId,
  });

describe('КП — версионирование и approve', () => {
  it('version назначается сервером последовательно; approve демотирует прочие approved', async () => {
    const kp1 = await mkKp(`${TEST_PREFIX} v-first`);
    const kp2 = await mkKp(`${TEST_PREFIX} v-second`);
    expect(kp1.version).toBe(1);
    expect(kp2.version).toBe(2);

    // total = works + parts
    const dto1 = await getKpById(getDb(), erfolgId, kp1.id);
    expect(dto1?.totalAmountKopecks).toBe('15000');

    // approve v1 → approved
    const approved1 = await approveKp(getDb(), erfolgId, kp1.id);
    expect(approved1?.status).toBe('approved');

    // approve v2 → v2 approved, v1 демотирован в rejected с авто-причиной
    const approved2 = await approveKp(getDb(), erfolgId, kp2.id);
    expect(approved2?.status).toBe('approved');
    const after1 = await getKpById(getDb(), erfolgId, kp1.id);
    expect(after1?.status).toBe('rejected');
    expect(after1?.rejectionReason).toContain('v2');

    // ровно одна approved-версия
    const all = await listByTicket(getDb(), erfolgId, ticketId);
    expect(all.filter((k) => k.status === 'approved').length).toBe(1);
  });

  it('guard: архив утверждённой запрещён; не-утверждённой — работает', async () => {
    const all = await listByTicket(getDb(), erfolgId, ticketId);
    const approved = all.find((k) => k.status === 'approved')!;
    const rejected = all.find((k) => k.status === 'rejected')!;

    await expect(archiveKpCmd(mkCmdCtx(), approved.id)).rejects.toThrowError(TRPCError);
    expect((await getKpById(getDb(), erfolgId, approved.id))?.status).toBe('approved');

    await expect(archiveKpCmd(mkCmdCtx(), rejected.id)).resolves.toEqual({ ok: true });
    expect(await getKpById(getDb(), erfolgId, rejected.id)).toBeNull();
  });

  it('RLS: чужой тенант не видит версии КП', async () => {
    const fromDemo = await listByTicket(getDb(), demoId, ticketId);
    expect(fromDemo.length).toBe(0);

    const all = await listByTicket(getDb(), erfolgId, ticketId);
    expect(all.length).toBeGreaterThan(0);
    expect(await getKpById(getDb(), demoId, all[0]!.id)).toBeNull();
    expect(await archiveKp(getDb(), demoId, all[0]!.id)).toBe(false);
  });
});

describe('Отчёты — smoke (SQL-агрегаты отвечают)', () => {
  const period = {};

  it('revenueByClient / engineerPerformance', async () => {
    const rev = await revenueByClient(getDb(), erfolgId, period);
    expect(Array.isArray(rev)).toBe(true);
    if (rev[0]) {
      expect(typeof rev[0].totalAmountKopecks).toBe('string');
      expect(rev[0].ticketsCount).toBeGreaterThanOrEqual(0);
    }
    const eng = await engineerPerformance(getDb(), erfolgId, period);
    expect(Array.isArray(eng)).toBe(true);
  });

  it('slaCompliance / leadsFunnel / receivables', async () => {
    const sla = await slaCompliance(getDb(), erfolgId, period);
    expect(sla.totalTracked).toBeGreaterThanOrEqual(0);
    expect(sla.onTime + sla.late).toBe(sla.totalTracked);

    const funnel = await leadsFunnel(getDb(), erfolgId, period);
    expect(funnel.total).toBeGreaterThanOrEqual(0);

    const recv = await receivables(getDb(), erfolgId);
    expect(typeof recv.totalRemainingKopecks).toBe('string');
    expect(BigInt(recv.totalRemainingKopecks)).toBeGreaterThanOrEqual(
      BigInt(recv.overdueRemainingKopecks),
    );
  });

  it('период сужает выборку (заведомо пустой диапазон)', async () => {
    const empty = await leadsFunnel(getDb(), erfolgId, { from: '1990-01-01', to: '1990-01-02' });
    expect(empty.total).toBe(0);
  });
});
