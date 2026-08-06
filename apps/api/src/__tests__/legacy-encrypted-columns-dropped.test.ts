/**
 * Уборка 0081: шифрованные колонки-предшественники удалены, рабочие секреты — нет.
 *
 * Почему это стоит стеречь тестом, а не «мы же посмотрели глазами».
 *   1. Шифрованные ПДн-колонки лежали мёртвым грузом с 21 июля: код их не читал,
 *      но по схеме казалось, будто картотека «под защитой». Если колонка вернётся
 *      (например, кто-то восстановит старую версию схемы), это снова введёт в
 *      заблуждение — тест поймает.
 *   2. Куда важнее обратное: под уборку НЕЛЬЗЯ было попасть шифрованию ЖИВЫХ секретов.
 *      Пароль почтового ящика читается из `email_configs` при каждой отправке письма;
 *      удали его колонку — и почта отвалится молча, а восстановить пароль можно только
 *      руками. Здесь мы прямо требуем, чтобы эти колонки остались на месте.
 *   3. `clients.phone_encrypted` намеренно ОСТАВЛЕН: на бою нашлись 3 физлица, у
 *      которых зашифрованный телефон есть, а открытого нет — для них это единственный
 *      экземпляр данных. Тест фиксирует это как осознанное решение, чтобы следующий
 *      чистильщик не снёс колонку «заодно».
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, withoutTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';

/** Имена шифрованных колонок таблицы — прямо из information_schema. */
async function encryptedColumnsOf(table: string): Promise<string[]> {
  const rows = await withoutTenantTx(getDb(), async (tx) =>
    tx.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND (column_name LIKE '%encrypted%' OR column_name LIKE '%\\_enc')
       ORDER BY column_name
    `),
  );
  return (rows as unknown as Array<{ column_name: string }>).map((r) => r.column_name);
}

beforeAll(async () => {
  await ensureSeed();
});

describe('уборка 0081: наследие шифрования ПДн удалено', () => {
  it('у контактов не осталось шифрованных колонок вовсе', async () => {
    expect(await encryptedColumnsOf('contacts')).toEqual([]);
  });

  it('у переписки не осталось шифрованных колонок вовсе', async () => {
    expect(await encryptedColumnsOf('email_messages')).toEqual([]);
  });

  it('у клиентов остался ТОЛЬКО телефон — три строки без открытой копии', async () => {
    // ФИО и адрес удалены; телефон ждёт решения владельца по 3 «сиротам».
    expect(await encryptedColumnsOf('clients')).toEqual(['phone_encrypted']);
  });
});

describe('живые секреты уборкой НЕ затронуты', () => {
  it('пароли почтового ящика на месте — иначе почта молча перестанет отправлять', async () => {
    const cols = await encryptedColumnsOf('email_configs');
    expect(cols).toContain('imap_password_encrypted');
    expect(cols).toContain('smtp_password_encrypted');
  });

  it('токен Telegram-бота и ключ ИИ на месте', async () => {
    expect(await encryptedColumnsOf('telegram_bot_configs')).toContain('bot_token_encrypted');
    expect(await encryptedColumnsOf('llm_configs')).toContain('api_key_encrypted');
  });

  it('секрет второго фактора на месте', async () => {
    expect(await encryptedColumnsOf('users')).toContain('totp_secret_enc');
  });
});
