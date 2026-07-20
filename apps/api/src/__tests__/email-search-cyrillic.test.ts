/**
 * Поиск по почте и русский регистр.
 *
 * База создана с локалью «C», где обычный ILIKE сворачивает регистр только для
 * латиницы: «Гастроскоп» по запросу «гастроскоп» не находился ВООБЩЕ — не
 * «иногда», а никогда. Лечится ruIlike (COLLATE "ru-x-icu"), тем же приёмом,
 * что заявки и клиенты в аудите 2026-06-11. Почта осталась единственным
 * модулем, выпавшим из той волны.
 *
 * Поля письма зашифрованы, поэтому фильтр идёт по pgp_sym_decrypt — ruIlike
 * поверх расшифровки работает, это и проверяем.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getTenantEncryptionKey, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { insertEmailMessage } from '../lib/email-journal';
import { listMessages } from '../modules/email/repository';

const TEST_PREFIX = 'TESTMAILRU-';

let erfolgId = '';
let encKey = '';
const stamp = String(Date.now()).slice(-8);

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  encKey = getTenantEncryptionKey({ id: erfolgId, kmsKeyId: null });
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM email_messages
       WHERE pgp_sym_decrypt(subject_encrypted::bytea, ${encKey})::text LIKE ${`${TEST_PREFIX}%`}
    `);
  });
}
afterAll(clearTestData);

describe('поиск по почте: русский регистр', () => {
  it('письмо «Гастроскоп» находится по запросу «гастроскоп»', async () => {
    const subject = `${TEST_PREFIX}Ремонт Гастроскоп ${stamp}`;
    await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'buh@klinika.test',
      subject,
      sentAt: new Date(),
    });

    const found = await listMessages(getDb(), erfolgId, encKey, {
      search: `гастроскоп ${stamp}`,
      pageSize: 50,
    });
    expect(found.total).toBeGreaterThanOrEqual(1);
  });

  it('находит и в обратную сторону — по запросу в верхнем регистре', async () => {
    const subject = `${TEST_PREFIX}счёт на оплату ${stamp}`;
    await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'info@klinika.test',
      subject,
      sentAt: new Date(),
    });

    const found = await listMessages(getDb(), erfolgId, encKey, {
      search: `СЧЁТ НА ОПЛАТУ ${stamp}`,
      pageSize: 50,
    });
    expect(found.total).toBeGreaterThanOrEqual(1);
  });

  it('чужого письма по этому запросу не возвращает', async () => {
    await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'x@klinika.test',
      subject: `${TEST_PREFIX}Совсем другая тема ${stamp}`,
      sentAt: new Date(),
    });

    const found = await listMessages(getDb(), erfolgId, encKey, {
      search: `гастроскоп ${stamp}`,
      pageSize: 50,
    });
    // Должно найтись ровно письмо из первого кейса, а не всё подряд.
    expect(found.items.every((m) => !m.subject?.includes('Совсем другая'))).toBe(true);
  });

  it('латиница по-прежнему ищется', async () => {
    await insertEmailMessage(getDb(), erfolgId, {
      direction: 'out',
      status: 'sent',
      to: 'billing@klinika.test',
      subject: `${TEST_PREFIX}Invoice ${stamp}`,
      sentAt: new Date(),
    });

    const found = await listMessages(getDb(), erfolgId, encKey, {
      search: `invoice ${stamp}`,
      pageSize: 50,
    });
    expect(found.total).toBeGreaterThanOrEqual(1);
  });
});
