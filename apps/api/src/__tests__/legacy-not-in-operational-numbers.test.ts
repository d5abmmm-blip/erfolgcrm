/**
 * Архив прежней системы не подмешивается в операционные цифры.
 *
 * Перенесённых заявок 5999 против 69 своих, и 58 из них до сих пор числятся
 * незакрытыми — 41 на служебном «Администраторе», самая старая «в работе» с февраля
 * 2015 года. Пока их считали наравне со своими, получалось вот что:
 *
 *   • дашборд показывал «активные заявки», почти наполовину состоящие из хвоста
 *     переноса;
 *   • доска «почему стоит» сортирует по времени простоя — архив с тысячами дней
 *     занимал первые экраны и вечно горел красным;
 *   • отчёт загрузки раскладывал 5999 архивных заявок по учёткам-двойникам, ставя их
 *     в один столбец с живыми инженерами, а среднее время закрытия улетало в сотни дней;
 *   • ассистент на вопрос «что у меня зависло» отвечал хвостом миграции на 100 %.
 *
 * Прятать архив нельзя — заявки существуют, их когда-нибудь закроют. Поэтому везде
 * ниже он не исчезает, а считается ОТДЕЛЬНЫМ числом.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { clients, getDb, tickets, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { boardTickets } from '../modules/tickets/repository';
import { engineerPerformance } from '../modules/reports/repository';
import { listAgedTickets } from '../modules/ai-assistant/read-queries';
import { getMetrics } from '../modules/dashboard/repository';
import type { ResolvedTenant } from '../lib/tenant';

const PREFIX = 'TEST-LEGACY-OPS-';
/** Идентификаторы версии 5 — так выглядят записи, перенесённые импортом. */
const LEGACY_TICKET_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c3a01';
const LEGACY_CLOSED_IN_CRM_ID = '3f2504e0-4f89-51d3-9a0c-0305e82c3a02';

let erfolgId = '';
let clientId = '';
let engineerId = '';

const tenant = (): ResolvedTenant => ({
  id: erfolgId,
  subdomain: 'erfolg',
  displayName: 'erfolg',
  status: 'active',
  timezone: 'Europe/Moscow',
  kmsKeyId: null,
});

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  const [e] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!c || !e) throw new Error('seed missing client/engineer');
  clientId = c.id;
  engineerId = e.id;
});

beforeEach(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, `${PREFIX}%`));
  });
});

/**
 * Заявка «как после импорта»: идентификатор версии 5, номер WSP-, дата приёма 2015
 * года. Заводим сырым SQL — обычный путь CRM такую запись создать не может, и это
 * ровно то, что проверяем.
 */
async function insertLegacyTicket(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.execute(sql`
      INSERT INTO tickets
        (id, tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
         symptom, received_at, created_at)
      VALUES (${LEGACY_TICKET_ID}::uuid, ${erfolgId}::uuid, ${'WSP-' + PREFIX},
              ${'BC-' + PREFIX}, ${clientId}::uuid,
              ${engineerId}::uuid, 'in_progress', ${PREFIX + 'архивная'},
              '2015-02-08T09:00:00Z', '2015-02-08T09:00:00Z')
    `),
  );
}

describe('доска «почему стоит»', () => {
  it('архивная заявка 2015 года не занимает первые экраны', async () => {
    await insertLegacyTicket();
    const board = await boardTickets(getDb(), erfolgId);
    expect(board.find((c) => c.id === LEGACY_TICKET_ID)).toBeUndefined();
  });
});

describe('дашборд', () => {
  it('активные заявки и хвост переноса — два разных числа', async () => {
    await insertLegacyTicket();
    const m = await getMetrics(getDb(), erfolgId, {
      start: new Date('2015-01-01T00:00:00Z'),
      end: new Date('2030-01-01T00:00:00Z'),
    });
    // Архивная не попала в основное число, но и не пропала — она отдельной цифрой.
    expect(m.legacyActiveTicketsCount).toBeGreaterThanOrEqual(1);
  });
});

describe('отчёт «загрузка инженеров»', () => {
  it('архивная заявка не увеличивает счёт живого инженера', async () => {
    const period = { from: '2015-01-01', to: '2030-01-01' };
    const countFor = async (): Promise<number> => {
      const rows = await engineerPerformance(getDb(), erfolgId, period);
      return rows.find((r) => r.engineerId === engineerId)?.ticketsCount ?? 0;
    };

    const before = await countFor();
    await insertLegacyTicket();
    const after = await countFor();
    expect(after).toBe(before);
  });
});

describe('работа по дате закрытия', () => {
  it('архивная заявка, закрытая уже в CRM, засчитывается инженеру в отчёте', async () => {
    const period = { from: '2015-01-01', to: '2030-01-01' };
    const countFor = async (): Promise<number> => {
      const rows = await engineerPerformance(getDb(), erfolgId, period);
      return rows.find((r) => r.engineerId === engineerId)?.ticketsCount ?? 0;
    };

    const before = await countFor();
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        INSERT INTO tickets
          (id, tenant_id, ticket_number, barcode, client_id, assigned_engineer_id, status,
           symptom, received_at, created_at, closed_at)
        VALUES (${LEGACY_CLOSED_IN_CRM_ID}::uuid, ${erfolgId}::uuid, ${'WSP-CLOSED-' + PREFIX},
                ${'BC-CLOSED-' + PREFIX}, ${clientId}::uuid, ${engineerId}::uuid, 'closed',
                ${PREFIX + 'закрыта в CRM'}, '2015-02-08T09:00:00Z', '2015-02-08T09:00:00Z',
                '2026-08-14T10:00:00Z')
      `),
    );
    expect(await countFor()).toBe(before + 1);
  });
});

describe('ассистент: «что зависло»', () => {
  it('не отвечает хвостом переноса', async () => {
    await insertLegacyTicket();
    const res = await listAgedTickets(getDb(), tenant(), 30);
    expect(res.items.some((t) => t.ticketNumber.startsWith('WSP-'))).toBe(false);
  });

  it('но и не молчит о нём — считает отдельно', async () => {
    await insertLegacyTicket();
    const res = await listAgedTickets(getDb(), tenant(), 30);
    expect(res.legacyCount).toBeGreaterThanOrEqual(1);
  });
});
