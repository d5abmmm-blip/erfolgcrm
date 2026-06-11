/**
 * Application-side helpers поверх pgcrypto для шифрования ПДн.
 *
 * Что это и зачем:
 *   pgp_sym_encrypt(text, key) — postgres-функция (extension pgcrypto), возвращает зашифрованный
 *   bytea. Расшифровка — pgp_sym_decrypt(blob, key). При утечке копии БД (бэкап, реплика, дамп)
 *   без ключа атакующий видит мусор.
 *
 * Что НЕ защищает:
 *   Атаку, в которой получены и БД, и application-сервер — ключ лежит в env. Полная защита
 *   потребует Yandex KMS (Этап 6+). Сейчас закладываем абстракцию `getTenantEncryptionKey`,
 *   подменим реализацию без правки репозиториев.
 *
 * Использование:
 *   const key = getTenantEncryptionKey(ctx.tenant);
 *   await tx.execute(sql`
 *     INSERT INTO contacts (..., full_name_encrypted)
 *     VALUES (..., pgp_sym_encrypt(${input.fullName}::text, ${key}))
 *   `);
 *   await tx.select({
 *     fullName: sql<string>`pgp_sym_decrypt(${contacts.fullNameEncrypted}::bytea, ${key})::text`,
 *     ...
 *   }).from(contacts);
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

const DEV_FALLBACK = 'dev-only-pii-key-DO-NOT-USE-IN-PROD';

let warnedAboutFallback = false;

export interface TenantKeyContext {
  id: string;
  kmsKeyId: string | null;
}

/**
 * Возвращает симметричный ключ для шифрования ПДн в данном tenant'е.
 *
 * Stage 2 (сейчас): берёт из env PII_ENCRYPTION_KEY.
 *   - В production отсутствие или dev-fallback значение → ошибка при первом вызове
 *     (приложение упадёт и systemd/docker рестартанёт его — лучше ранний краш, чем
 *     зашифровать боевые ПДн ключом, который лежит в git и бэкапах).
 *   - В dev/test допускается dev-fallback (с warning'ом в логах).
 * tenant.kmsKeyId пока игнорируется.
 *
 * Stage 6+: `kmsKeyId` будет ARN ключа в Yandex KMS, функция распакует data-key,
 * закеширует на 5 минут per-tenant. Сигнатура и контракт не меняются.
 */
export function getTenantEncryptionKey(_tenant: TenantKeyContext): string {
  const fromEnv = process.env.PII_ENCRYPTION_KEY;
  const isProd = process.env.NODE_ENV === 'production';

  if (fromEnv && fromEnv.length > 0 && fromEnv !== DEV_FALLBACK) {
    return fromEnv;
  }

  if (isProd) {
    throw new Error(
      'PII_ENCRYPTION_KEY is not set or uses the dev fallback in production. ' +
        'Generate a secure 32-byte key (`node scripts/generate-pii-key.mjs`) and put it in the env. ' +
        'Refusing to encrypt PII with a known dev key.',
    );
  }

  if (!warnedAboutFallback && process.env.NODE_ENV !== 'test') {
     
    console.warn(
      '[crypto] PII_ENCRYPTION_KEY not set (or equals dev fallback) — using dev fallback. ' +
        'NEVER deploy this to production.',
    );
    warnedAboutFallback = true;
  }
  return DEV_FALLBACK;
}

/**
 * Строит SQL-фрагмент `pgp_sym_encrypt(${value}, ${key})` для INSERT/UPDATE.
 * Если value === null/undefined — возвращает фрагмент NULL (для опциональных колонок).
 */
export function encryptSql(value: string | null | undefined, key: string): SQL {
  if (value == null) return sql`NULL`;
  return sql`pgp_sym_encrypt(${value}::text, ${key})`;
}

/**
 * Строит SQL-фрагмент `pgp_sym_decrypt(${col}::bytea, ${key})::text` для SELECT-проекций.
 * Если ячейка NULL — функция возвращает NULL (а не ошибку).
 */
export function decryptSql(col: PgColumn, key: string): SQL {
  return sql`CASE WHEN ${col} IS NULL THEN NULL ELSE pgp_sym_decrypt(${col}::bytea, ${key})::text END`;
}
