/**
 * Этап 7-B — full flow handler'а: 4 уточнения → создание клиента + заявки + push диспетчеру.
 *
 * Mock'аем global fetch (для api.telegram.org/sendMessage), используем реальные DB+Redis.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { like } from 'drizzle-orm';
import { clients, getDb, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { handleUpdate } from '../modules/telegram/handler';
import { clearConversation } from '../modules/telegram/conversation';
import type { TgUpdate } from '../lib/telegram-client';

let erfolgId = '';
const erfolgKmsKeyId: string | null = null;

const TEST_CHAT_ID = 999_888_777;
const FAKE_TOKEN = '1:fake';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

beforeEach(async () => {
  await clearConversation(erfolgId, TEST_CHAT_ID);
  // Чистим test-данные
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.symptom, 'TG-TEST%'));
    await tx.delete(clients).where(like(clients.displayName, 'TG-TEST%'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeUpdate(text: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      date: Math.floor(Date.now() / 1000),
      chat: { id: TEST_CHAT_ID, type: 'private' },
      text,
    },
  };
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('telegram handler full flow', () => {
  it('4 уточнения создают клиента и заявку', async () => {
    const fetchSpy = stubFetch();
    const ctx = {
      db: getDb(),
      tenant: { id: erfolgId, subdomain: 'erfolg', kmsKeyId: erfolgKmsKeyId },
      botToken: FAKE_TOKEN,
      defaultDispatcherUserId: null,
    };

    // /start
    await handleUpdate(ctx, makeUpdate('/start'));
    // q1: имя
    await handleUpdate(ctx, makeUpdate('TG-TEST Иван Петров'));
    // q2: телефон
    await handleUpdate(ctx, makeUpdate('+7 928 555 11 22'));
    // q3: симптом
    await handleUpdate(ctx, makeUpdate('TG-TEST УЗИ Mindray не включается'));
    // q4: адрес
    await handleUpdate(ctx, makeUpdate('г. Грозный, ул. Мичурина 98'));

    // Проверяем — в БД появился клиент + заявка
    const [createdClient] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(clients).where(like(clients.displayName, 'TG-TEST %')).limit(1),
    );
    expect(createdClient).toBeDefined();
    expect(createdClient?.type).toBe('individual');

    const [createdTicket] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(tickets).where(like(tickets.symptom, 'TG-TEST%')).limit(1),
    );
    expect(createdTicket).toBeDefined();
    expect(createdTicket?.source).toBe('telegram');
    expect(createdTicket?.clientId).toBe(createdClient?.id);

    // sendMessage был вызван несколько раз (4 prompt'а + finальное «Спасибо»)
    const sendCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('sendMessage'));
    expect(sendCalls.length).toBeGreaterThanOrEqual(5);
  });

  it('некорректный ответ просит повторить и не двигает шаг', async () => {
    stubFetch();
    const ctx = {
      db: getDb(),
      tenant: { id: erfolgId, subdomain: 'erfolg', kmsKeyId: erfolgKmsKeyId },
      botToken: FAKE_TOKEN,
      defaultDispatcherUserId: null,
    };
    await handleUpdate(ctx, makeUpdate('/start'));
    // Имя короткое — отказ.
    await handleUpdate(ctx, makeUpdate('А'));
    // Имя нормальное — принимается, переходим на ASK_PHONE.
    await handleUpdate(ctx, makeUpdate('TG-TEST Сидоров С.С.'));
    // Слишком короткий телефон.
    await handleUpdate(ctx, makeUpdate('123'));
    // Нормальный.
    await handleUpdate(ctx, makeUpdate('+79285551122'));
    // Симптом и адрес.
    await handleUpdate(ctx, makeUpdate('TG-TEST холодильник не морозит'));
    await handleUpdate(ctx, makeUpdate('г. Грозный, аптека'));

    const [createdTicket] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(tickets).where(like(tickets.symptom, 'TG-TEST%')).limit(1),
    );
    expect(createdTicket).toBeDefined();
  });

  it('сообщение без активного диалога подсказывает /start', async () => {
    const fetchSpy = stubFetch();
    const ctx = {
      db: getDb(),
      tenant: { id: erfolgId, subdomain: 'erfolg', kmsKeyId: erfolgKmsKeyId },
      botToken: FAKE_TOKEN,
      defaultDispatcherUserId: null,
    };
    await handleUpdate(ctx, makeUpdate('Привет'));
    const calls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('sendMessage'));
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0]?.[1]?.body as string) ?? '{}');
    expect(body.text).toMatch(/start/);
  });
});

void erfolgKmsKeyId;
