/**
 * Переписка с клиентами хранится ОТКРЫТО (миграция 0079 + скрипт decrypt-pii).
 *
 * Продолжение 0078, где так же перевели ПДн клиентов. Причина та же: ключ лежал
 * в .env на том же сервере, что и база, поэтому от её кражи не защищал, а его потеря
 * делала переписку нечитаемой навсегда. У почты была и вторая беда — поиск: фильтр
 * расшифровывал КАЖДУЮ строку, и запрос выполнялся дважды (страница + счётчик).
 *
 * ⚠️ Пароли ящика (email_configs.smtp/imap_password_encrypted) остаются
 * ЗАШИФРОВАННЫМИ — тест 6 стережёт, чтобы их не «зачистили» заодно.
 *
 * Что проверяем:
 *   1-2. Письмо пишется и читается без ключа; в базе лежит текстом, а не байтами.
 *   3.   Поиск по теме (русский регистр — ruIlike, локаль «C»).
 *   4.   Поиск по «От кого» — РАНЬШЕ ЭТОГО НЕ БЫЛО: поле не включали в фильтр,
 *        потому что каждое условие стоило ещё одной расшифровки на строку.
 *   5.   По телу письма НЕ ищем — это осознанное решение, а не забытое поле.
 *   6.   Пароли ящика по-прежнему зашифрованы.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { insertEmailMessage } from '../lib/email-journal';
import { listMessages } from '../modules/email/repository';

const P = 'TESTPLAINMAIL-';
const stamp = String(Date.now()).slice(-8);

let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM email_messages
       WHERE subject LIKE ${`${P}%`} OR from_addr LIKE ${`%${stamp}%`}
    `);
  });
});

describe('переписка хранится открыто', () => {
  it('1. письмо пишется и читается без ключа шифрования', async () => {
    const id = await insertEmailMessage(getDb(), erfolgId, {
      direction: 'in',
      status: 'received',
      to: 'info@erfolgmt.ru',
      from: `zakupki-${stamp}@gorbolnica.test`,
      subject: `${P}Ремонт Гастроскопа ${stamp}`,
      bodyText: 'Здравствуйте! Аппарат не включается.',
      receivedAt: new Date(),
    });
    expect(id).toBeTruthy();

    const { items } = await listMessages(getDb(), erfolgId, {
      search: `${P}Ремонт Гастроскопа ${stamp}`,
      pageSize: 50,
    });
    const found = items.find((m) => m.id === id);
    expect(found).toBeTruthy();
    expect(found?.subject).toBe(`${P}Ремонт Гастроскопа ${stamp}`);
    expect(found?.from).toBe(`zakupki-${stamp}@gorbolnica.test`);
  });

  it('2. в базе лежит текстом, а не зашифрованными байтами', async () => {
    const subject = `${P}Проверка хранения ${stamp}`;
    await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'a@b.test',
      subject,
      sentAt: new Date(),
    });

    // Читаем колонку НАПРЯМУЮ: при шифровании сравнение со строкой не сошлось бы.
    const rows = (await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        SELECT subject,
               -- колонка удалена уборкой 0081; если она вернётся, тест это заметит
               (SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'email_messages'
                   AND column_name LIKE '%_encrypted') AS legacy_columns
          FROM email_messages WHERE subject = ${subject}
      `),
    )) as unknown as Array<{ subject: string; legacy_columns: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe(subject);
    // Шифрованных колонок у переписки больше нет вовсе.
    expect(Number(rows[0]?.legacy_columns)).toBe(0);
  });
});

describe('поиск по почте', () => {
  it('3. находит по теме в другом регистре (локаль «C», ruIlike)', async () => {
    const id = await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'x@y.test',
      subject: `${P}Счёт на ОПЛАТУ ${stamp}`,
      sentAt: new Date(),
    });

    const { items } = await listMessages(getDb(), erfolgId, {
      search: `счёт на оплату ${stamp}`,
      pageSize: 50,
    });
    expect(items.map((m) => m.id)).toContain(id);
  });

  it('4. находит по «ОТ КОГО» — раньше это поле в фильтр не входило', async () => {
    const sender = `glavvrach-${stamp}@rkb.test`;
    const id = await insertEmailMessage(getDb(), erfolgId, {
      direction: 'in',
      status: 'received',
      to: 'info@erfolgmt.ru',
      from: sender,
      // Тема НЕ содержит отправителя — если бы поиск смотрел только в неё, не нашлось бы.
      subject: `${P}Без упоминания отправителя ${stamp}`,
      receivedAt: new Date(),
    });

    const { items } = await listMessages(getDb(), erfolgId, {
      search: `glavvrach-${stamp}`,
      pageSize: 50,
    });
    expect(items.map((m) => m.id)).toContain(id);
  });

  it('5. по ТЕЛУ письма не ищет (решение осознанное, не забытое поле)', async () => {
    const id = await insertEmailMessage(getDb(), erfolgId, {
      direction: 'in',
      status: 'received',
      to: 'info@erfolgmt.ru',
      from: `noreply-${stamp}@spam.test`,
      subject: `${P}Обычное письмо ${stamp}`,
      bodyText: `Уникальное слово внутри тела: колоноскоп${stamp}`,
      receivedAt: new Date(),
    });

    const { items } = await listMessages(getDb(), erfolgId, {
      search: `колоноскоп${stamp}`,
      pageSize: 50,
    });
    expect(items.map((m) => m.id)).not.toContain(id);
  });
});

describe('служебные секреты', () => {
  it('6. пароли почтового ящика ОСТАЛИСЬ зашифрованными', async () => {
    // Колонки должны существовать и быть bytea — если их «зачистят» вместе с письмами,
    // пароль от боевого ящика ляжет в бэкап открытым текстом.
    const rows = (await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.execute(sql`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'email_configs'
           AND column_name IN ('smtp_password_encrypted','imap_password_encrypted')
         ORDER BY column_name
      `),
    )) as unknown as Array<{ column_name: string; data_type: string }>;

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.data_type === 'bytea')).toBe(true);
  });
});
