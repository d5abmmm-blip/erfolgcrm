/**
 * PostgreSQL клиент через postgres.js + Drizzle ORM.
 * Singleton — один пул на процесс.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let _db: ReturnType<typeof createDb> | undefined;

function createDb(connectionString: string) {
  const queryClient = postgres(connectionString, {
    max: 20,
    idle_timeout: 20,
    connect_timeout: 10,
    // Логи в dev только при verbose
    debug: process.env.PG_DEBUG === 'true',
  });
  return drizzle(queryClient, { schema, casing: 'snake_case' });
}

const DEV_FALLBACK_URL = 'postgresql://app_runtime:app_runtime_dev_only@localhost:5432/erfolg_dev';

export function getDb() {
  if (!_db) {
    const url =
      process.env.DATABASE_URL ?? (process.env.NODE_ENV === 'production' ? null : DEV_FALLBACK_URL);
    if (!url) throw new Error('DATABASE_URL is required in production');
    _db = createDb(url);
  }
  return _db;
}

export type Db = ReturnType<typeof getDb>;

/** Только для тестов и seed-скриптов — позволяет передать кастомный URL */
export function makeDb(url: string) {
  return createDb(url);
}
