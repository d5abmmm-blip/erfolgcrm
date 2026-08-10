/**
 * attachments.delete: чужое вложение инженер удалить не может.
 *
 * Шапка роутера attachments ОБЕЩАЛА «staff + engineer для фото», но фактически
 * delete был engineerProcedure без единой проверки: любой инженер мог по id
 * безвозвратно снести любой файл тенанта — включая скан подписанного договора
 * (soft-delete + purge из S3 фоновым job'ом через 24 часа).
 *
 * Правило (в духе «чужая заявка — смотреть всем, менять только свои»):
 *  - менеджер/директор удаляют любое вложение;
 *  - инженер — только загруженное им самим (uploadedByUserId).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { attachments, clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createTicket } from '../modules/tickets/repository';
import { insertPending } from '../modules/attachments/repository';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const TEST_PREFIX = 'TEST-ATT-OWN-';

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
    await tx.delete(attachments).where(like(attachments.objectKey, `%${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(opts: { role: 'dispatcher' | 'engineer'; userId?: string }): Context {
  const userId = opts.userId ?? (opts.role === 'engineer' ? engineerId : dispatcherId);
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

/** Вложение к свежей заявке, загруженное указанным пользователем (минуя storage). */
async function makeAttachment(uploadedBy: string | null): Promise<string> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}ticket`,
  });
  const dto = await insertPending(getDb(), erfolgId, {
    kind: 'document',
    referenceType: 'ticket',
    referenceId: ticketId,
    objectKey: `tenants/${erfolgId}/${TEST_PREFIX}${Date.now()}-${Math.random()}.pdf`,
    originalName: 'contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024n,
    userId: uploadedBy,
  });
  return dto.id;
}

describe('attachments.delete — принадлежность', () => {
  it('инженер НЕ может удалить вложение, загруженное другим человеком', async () => {
    const id = await makeAttachment(dispatcherId);
    const engineer = appRouter.createCaller(makeCtx({ role: 'engineer' }));

    await expect(engineer.attachments.delete({ id })).rejects.toThrow(/менеджер или директор/);

    // Вложение пережило попытку: диспетчер удаляет его штатно (softDelete
    // срабатывает только по живой записи — после удаления вернул бы NOT_FOUND).
    const dispatcher = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expect(dispatcher.attachments.delete({ id })).resolves.toEqual({ ok: true });
  });

  it('вложение без автора (импорт) инженер удалить не может', async () => {
    const id = await makeAttachment(null);
    const engineer = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expect(engineer.attachments.delete({ id })).rejects.toThrow(/менеджер или директор/);
  });

  it('своё вложение инженер удаляет как раньше', async () => {
    const id = await makeAttachment(engineerId);
    const engineer = appRouter.createCaller(makeCtx({ role: 'engineer' }));
    await expect(engineer.attachments.delete({ id })).resolves.toEqual({ ok: true });
  });

  it('диспетчер удаляет любое вложение (в т.ч. инженера)', async () => {
    const id = await makeAttachment(engineerId);
    const dispatcher = appRouter.createCaller(makeCtx({ role: 'dispatcher' }));
    await expect(dispatcher.attachments.delete({ id })).resolves.toEqual({ ok: true });
  });
});
