/**
 * Перенос ПДн из шифрованных колонок в открытые.
 *
 * Пара к миграциям 0078 (клиенты и контакты) и 0079 (переписка): миграции создают
 * пустые открытые колонки, этот скрипт их наполняет. Ключ шифрования в .sql-файл
 * не передать, поэтому расшифровка живёт отдельно, здесь.
 *
 * ⚠️ СВОЮ ОСНОВНУЮ РАБОТУ СКРИПТ УЖЕ СДЕЛАЛ (бой, 21.07.2026: 937 значений, сверка
 * сошлась построчно), и уборка 0081 удалила перенесённые колонки. Осталась ОДНА пара —
 * `clients.phone_encrypted` → `individual_phone`: на бою нашлись 3 физлица, у которых
 * зашифрованный телефон есть, а открытого нет. Скрипт живёт ради них: когда владелец
 * решит, что делать с этими номерами, он их перенесёт (либо колонку удалят как есть).
 *
 * ЧТО ПЕРЕНОСИТ: см. список MOVES ниже.
 *
 * ⚠️ ЧЕГО НЕ ТРОГАЕТ СОЗНАТЕЛЬНО — служебные секреты, они ОСТАЮТСЯ зашифрованными:
 *   email_configs.smtp_password_encrypted / imap_password_encrypted,
 *   telegram_bot_configs.*, llm_configs.api_key_encrypted, секреты 2FA в users.
 *   Их потеря лечится повторным вводом, в отличие от писем и картотеки.
 *   Поэтому PII_ENCRYPTION_KEY нужен и после переноса — просто перестаёт быть смертельным.
 *
 * ЧЕГО НЕ ДЕЛАЕТ: не удаляет шифрованные колонки — это отдельная миграция-уборка,
 * после того как перенос проверен. Пока они на месте, откат стоит ноль.
 *
 * БЕЗОПАСНОСТЬ: расшифрованные значения — это ПДн живых людей. Скрипт НЕ печатает их
 * ни при каких флагах: в отчёт идут только количества. Данные не покидают базу — вся
 * расшифровка происходит внутри Postgres (`UPDATE ... SET x = pgp_sym_decrypt(y, key)`),
 * ФИО и телефоны не проезжают через Node и не попадают в логи.
 *
 * ИДЕМПОТЕНТНОСТЬ: переносит только строки, где открытая колонка ещё пуста, а шифрованная
 * заполнена. Повторный запуск не портит уже перенесённое и не затирает ручные правки.
 *
 * Запуск (сухой прогон — только отчёт, в базу не пишет):
 *   pnpm --filter @erfolg/db decrypt-pii --dry-run
 * Реальный перенос на dev:
 *   pnpm --filter @erfolg/db decrypt-pii
 * На бою (ключ и адрес базы берутся из окружения контейнера api):
 *   DATABASE_OWNER_URL=... PII_ENCRYPTION_KEY=... pnpm --filter @erfolg/db decrypt-pii
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeDb } from './client';

// `dotenv/config` смотрит только в текущий каталог, а скрипт запускают из packages/db,
// где .env нет — он лежит в корне репозитория. Поднимаемся вверх до первого найденного.
// Уже заданные переменные окружения приоритетнее файла (на бою ключ передают строкой).
for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 5; i++, dir = dirname(dir)) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    break;
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const DATABASE_URL =
  process.env.DATABASE_OWNER_URL ??
  process.env.DATABASE_URL ??
  'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev';

type Db = ReturnType<typeof makeDb>;

/** Одна колонка к переносу: откуда, куда, в какой таблице. */
interface Move {
  table: 'clients' | 'contacts' | 'email_messages';
  from: string;
  to: string;
}

// Остальные пары (ФИО/адрес клиентов, ПДн контактов, вся переписка) убраны вместе
// с колонками в миграции 0081 — переносить больше нечего и не из чего.
// ⚠️ Пароли ящика (email_configs.smtp/imap_password_encrypted), токены Telegram,
// ключ ИИ и секреты 2FA НЕ переносятся сознательно: это секреты доступа, они
// остаются зашифрованными, и ради них PII_ENCRYPTION_KEY нужен по-прежнему.
const MOVES: Move[] = [
  { table: 'clients', from: 'phone_encrypted', to: 'individual_phone' },
];

/**
 * Сверка: открытое значение должно совпадать с расшифровкой шифрованного.
 *
 * «Пустых не осталось» доказывает лишь, что что-то записалось, но не что записалось
 * ВЕРНОЕ. Здесь сравниваем построчно — пока старые колонки на месте, это возможно
 * и стоит копейки. IS DISTINCT FROM, а не <>: обычное сравнение с NULL даёт NULL,
 * и строка молча не попала бы в счётчик расхождений.
 */
async function countMismatches(db: Db, m: Move, key: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(m.table)}
        WHERE ${sql.identifier(m.from)} IS NOT NULL
          AND ${sql.identifier(m.to)} IS DISTINCT FROM
              pgp_sym_decrypt(${sql.identifier(m.from)}::bytea, ${key})::text`,
  );
  return Number((rows as unknown as Array<{ n: string }>)[0]?.n ?? 0);
}

async function countPending(db: Db, m: Move): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(m.table)}
        WHERE ${sql.identifier(m.from)} IS NOT NULL AND ${sql.identifier(m.to)} IS NULL`,
  );
  return Number((rows as unknown as Array<{ n: string }>)[0]?.n ?? 0);
}

/**
 * Проверка ключа ДО первой записи.
 *
 * Зачем отдельно: при неверном ключе pgp_sym_decrypt бросает «Wrong key or corrupt data»
 * и роняет всю транзакцию. Без этой пробы человек увидел бы простыню от Postgres посреди
 * переноса и не понял бы, что дело в ключе. Проба читает ОДНУ строку и ничего не пишет.
 */
async function probeKey(db: Db, key: string): Promise<void> {
  // Проба идёт по телефону: колонка с ФИО удалена уборкой 0081, телефон — последняя
  // оставшаяся шифрованная ПДн-колонка (см. шапку файла).
  const probe = await db.execute<{ len: number }>(
    sql`SELECT length(pgp_sym_decrypt(phone_encrypted::bytea, ${key})::text) AS len
        FROM clients WHERE phone_encrypted IS NOT NULL LIMIT 1`,
  );
  const arr = probe as unknown as Array<{ len: number }>;
  if (arr.length === 0) {
    console.info('Проба ключа: зашифрованных телефонов в базе нет — проверять нечего.');
    return;
  }
  if (!arr[0]?.len || arr[0].len <= 0) {
    throw new Error('Ключ расшифровал телефон в пустую строку — данные повреждены.');
  }
  // Печатаем ДЛИНУ, а не сам номер: длина доказывает, что ключ подошёл, и не является ПДн.
  console.info(`Проба ключа: ПДн расшифровываются (контрольный телефон, длина ${arr[0].len}).`);
}

async function main(): Promise<void> {
  const key = process.env.PII_ENCRYPTION_KEY;
  if (!key) {
    console.error(
      'Не задан PII_ENCRYPTION_KEY — без него расшифровать нечем.\n' +
        'На боевом сервере взять из окружения api:\n' +
        '  docker exec erfolgcrm-api-prod printenv PII_ENCRYPTION_KEY',
    );
    process.exit(1);
  }

  const db = makeDb(DATABASE_URL);
  try {
    await probeKey(db, key);

    const before: number[] = [];
    for (const m of MOVES) before.push(await countPending(db, m));

    console.info('\nК переносу:');
    MOVES.forEach((m, i) => console.info(`  ${(m.table + '.' + m.to).padEnd(38)} ${before[i]}`));
    const total = before.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // Переносить нечего — значит скрипт уже отработал. Повторный запуск в этом
      // случае полезен как ПРОВЕРКА: сверяем, что лежащее открыто всё ещё совпадает
      // с расшифровкой старых колонок.
      let drift = 0;
      for (const m of MOVES) drift += await countMismatches(db, m, key);
      if (drift > 0) {
        throw new Error(
          `Переносить нечего, но ${drift} значений РАСХОДЯТСЯ с расшифровкой старых колонок.`,
        );
      }
      console.info('\nПереносить нечего — всё уже на месте, сверка с шифрованными колонками сошлась.');
      return;
    }

    if (DRY_RUN) {
      console.info(`\n[сухой прогон] Перенеслось бы значений: ${total}. В базу НЕ писал.`);
      return;
    }

    // Один UPDATE на колонку, все в ОДНОЙ транзакции: либо переносится всё, либо ничего.
    // Частичный перенос был бы худшим исходом — часть карточек с данными, часть без,
    // и непонятно, где остановились.
    await db.transaction(async (tx) => {
      for (const m of MOVES) {
        await tx.execute(
          sql`UPDATE ${sql.identifier(m.table)}
              SET ${sql.identifier(m.to)} = pgp_sym_decrypt(${sql.identifier(m.from)}::bytea, ${key})::text
              WHERE ${sql.identifier(m.from)} IS NOT NULL AND ${sql.identifier(m.to)} IS NULL`,
        );
      }
    });

    const after: number[] = [];
    for (const m of MOVES) after.push(await countPending(db, m));

    console.info('\nПеренесено:');
    MOVES.forEach((m, i) => {
      const moved = (before[i] ?? 0) - (after[i] ?? 0);
      console.info(`  ${(m.table + '.' + m.to).padEnd(38)} ${moved} (осталось ${after[i] ?? 0})`);
    });

    const left = after.reduce((a, b) => a + b, 0);
    if (left > 0) {
      throw new Error(
        `После переноса осталось ${left} незаполненных значений — перенос НЕ полный, разбираться.`,
      );
    }

    let mismatches = 0;
    for (const m of MOVES) mismatches += await countMismatches(db, m, key);
    if (mismatches > 0) {
      throw new Error(
        `Сверка НЕ прошла: ${mismatches} значений не совпали с расшифровкой. ` +
          'Старые шифрованные колонки на месте — данные не потеряны, разбираться до удаления.',
      );
    }
    console.info('\nСверка: все перенесённые значения совпали с расшифровкой старых колонок.');
    console.info('Готово. Картотека клиентов и переписка лежат открыто.');
    console.info('Служебные пароли (почта, бот, ИИ, 2FA) остались зашифрованными — так и задумано.');
  } finally {
    await db.$client.end();
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Wrong key or corrupt data/i.test(msg)) {
    console.error(
      'НЕВЕРНЫЙ КЛЮЧ: Postgres не смог расшифровать ПДн этим PII_ENCRYPTION_KEY.\n' +
        'Ничего не изменено. Взять рабочий ключ из окружения живого api и повторить.',
    );
  } else {
    console.error(msg);
  }
  process.exit(1);
});
