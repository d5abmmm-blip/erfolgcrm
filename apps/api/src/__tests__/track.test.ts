/**
 * Фича №3 «Трек как посылку» — публичное отслеживание по токену.
 *
 * Покрытие:
 *   1. getOrCreateTrackToken идемпотентен (повтор → тот же токен), формат UUID.
 *   2. trackByTokenQuery отдаёт PII-free DTO с корректным таймлайном стадий.
 *   3. Неизвестный токен → null (публично это 404).
 *   4. Cross-tenant: токен заявки erfolg не находится из tenant demo (RLS).
 *   5. Отзыв ссылки → токен перестаёт работать; повторная выдача = НОВЫЙ токен.
 *   6. getOrCreateTrackToken для несуществующей заявки → ошибка (NOT_FOUND).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { clients, getDb, tickets, ticketEvents, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  addNote,
  changeStatus,
  createTicket,
  getOrCreateTrackToken,
  revokeTrackToken,
  setWaitingForPart,
} from '../modules/tickets/repository';
import { getMyTicketById } from '../modules/client-cabinet/repository';
import { trackByTokenQuery } from '../modules/track/service';

let erfolgId = '';
let demoId = '';
let erfolgClientId = '';
const createdTicketIds: string[] = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [c] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: clients.id }).from(clients).limit(1),
  );
  if (!c) throw new Error('seed missing client');
  erfolgClientId = c.id;
});

afterAll(async () => {
  if (!createdTicketIds.length) return;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(ticketEvents).where(inArray(ticketEvents.ticketId, createdTicketIds));
    await tx.delete(tickets).where(inArray(tickets.id, createdTicketIds));
  });
});

async function makeTicket(): Promise<string> {
  const t = await createTicket(getDb(), erfolgId, null, {
    clientId: erfolgClientId,
    symptom: 'TRACKTEST-не включается',
  });
  createdTicketIds.push(t.id);
  return t.id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('track: публичная ссылка отслеживания', () => {
  it('getOrCreateTrackToken идемпотентен и отдаёт валидный UUID', async () => {
    const id = await makeTicket();
    const tok1 = await getOrCreateTrackToken(getDb(), erfolgId, id);
    const tok2 = await getOrCreateTrackToken(getDb(), erfolgId, id);
    expect(tok1).toBe(tok2);
    expect(tok1).toMatch(UUID_RE);
  });

  it('trackByTokenQuery: PII-free DTO с корректным таймлайном', async () => {
    const id = await makeTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    const tok = await getOrCreateTrackToken(getDb(), erfolgId, id);

    const dto = await trackByTokenQuery(getDb(), erfolgId, 'ООО Эрфольг', tok);
    expect(dto).not.toBeNull();
    expect(dto!.companyName).toBe('ООО Эрфольг');
    expect(dto!.ticketNumber).toMatch(/^T-/);
    // Стадия «Ремонт» (in_progress) — текущая (индекс 2 из 5); диагностика — пройдена.
    // Стадии «Смета/Согласование» убраны из потока.
    expect(dto!.timeline.currentIndex).toBe(2);
    expect(dto!.timeline.stages[2]!.state).toBe('current');
    expect(dto!.timeline.stages[1]!.state).toBe('done');
    expect(dto!.timeline.cancelled).toBe(false);
    // Наружу уходят ТОЛЬКО эти ключи — никаких ФИО/адреса/телефона/цен/инженера.
    expect(Object.keys(dto!).sort()).toEqual([
      'companyName',
      'deviceLabel',
      'ticketNumber',
      'timeline',
    ]);
  });

  it('неизвестный токен → null', async () => {
    const dto = await trackByTokenQuery(getDb(), erfolgId, 'x', randomUUID());
    expect(dto).toBeNull();
  });

  it('cross-tenant: токен заявки erfolg не виден из tenant demo', async () => {
    const id = await makeTicket();
    const tok = await getOrCreateTrackToken(getDb(), erfolgId, id);
    const fromDemo = await trackByTokenQuery(getDb(), demoId, 'demo', tok);
    expect(fromDemo).toBeNull();
  });

  it('отзыв ссылки: токен перестаёт работать, повторная выдача = новый токен', async () => {
    const id = await makeTicket();
    const tok = await getOrCreateTrackToken(getDb(), erfolgId, id);
    await revokeTrackToken(getDb(), erfolgId, id);
    expect(await trackByTokenQuery(getDb(), erfolgId, 'x', tok)).toBeNull();

    const tok2 = await getOrCreateTrackToken(getDb(), erfolgId, id);
    expect(tok2).not.toBe(tok);
    expect(await trackByTokenQuery(getDb(), erfolgId, 'x', tok2)).not.toBeNull();
  });

  it('getOrCreateTrackToken для несуществующей заявки → ошибка', async () => {
    await expect(getOrCreateTrackToken(getDb(), erfolgId, randomUUID())).rejects.toThrow();
  });

  it('публичный DTO НЕ содержит текст внутренней заметки «ждём запчасть»', async () => {
    const id = await makeTicket();
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');
    await changeStatus(getDb(), erfolgId, null, id, 'in_progress');
    await setWaitingForPart(getDb(), erfolgId, null, id, true, 'поставщик МедКомплект, счёт 47500');
    const tok = await getOrCreateTrackToken(getDb(), erfolgId, id);

    const dto = await trackByTokenQuery(getDb(), erfolgId, 'x', tok);
    expect(dto).not.toBeNull();
    expect(dto!.timeline.waitingForPart).toBe(true);
    // Внутренняя заметка (поставщик/цена) не должна встречаться нигде в публичном DTO.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('МедКомплект');
    expect(serialized).not.toContain('47500');
    expect('waitingForPartNote' in dto!.timeline).toBe(false);
  });

  it('кабинет getMyTicketById отдаёт клиенту только status_change (без внутренних заметок/назначений)', async () => {
    const id = await makeTicket();
    await addNote(getDb(), erfolgId, null, id, 'внутренняя заметка менеджера СЕКРЕТ-ТЕКСТ');
    await changeStatus(getDb(), erfolgId, null, id, 'diagnostics');

    const t = await getMyTicketById(getDb(), erfolgId, erfolgClientId, id);
    expect(t).not.toBeNull();
    expect(t!.events.length).toBeGreaterThan(0);
    expect(t!.events.every((e) => e.type === 'status_change')).toBe(true);
    expect(JSON.stringify(t!.events)).not.toContain('СЕКРЕТ-ТЕКСТ');
  });

  it('гонка getOrCreateTrackToken: одновременные вызовы дают ОДИН живой токен', async () => {
    const id = await makeTicket();
    const [a, b, c] = await Promise.all([
      getOrCreateTrackToken(getDb(), erfolgId, id),
      getOrCreateTrackToken(getDb(), erfolgId, id),
      getOrCreateTrackToken(getDb(), erfolgId, id),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // И этот токен реально резолвится (не «мёртвый»).
    expect(await trackByTokenQuery(getDb(), erfolgId, 'x', a)).not.toBeNull();
  });
});
