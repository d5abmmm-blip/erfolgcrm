/**
 * Setup для тестов: загружает .env, проверяет что seed-данные есть в БД.
 *
 * Тесты ходят в ОТДЕЛЬНУЮ базу erfolg_test (та же docker-Postgres, другая БД):
 * рабочие данные erfolg_dev не загрязняются TEST-* записями. getDb() ленивый —
 * переопределение DATABASE_URL здесь срабатывает до первого подключения.
 * Бутстрап тест-базы (однократно): см. docs/dev-test-db.md.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://app_runtime:app_runtime_dev_only@localhost:5432/erfolg_test';

// Заранее проверяем что есть seed-tenant'ы — иначе тесты бесполезны
export async function ensureSeed() {
  const db = getDb();
  const erfolg = await db.select().from(tenants).where(eq(tenants.subdomain, 'erfolg')).limit(1);
  const demo = await db.select().from(tenants).where(eq(tenants.subdomain, 'demo')).limit(1);
  if (!erfolg[0] || !demo[0]) {
    throw new Error('Seed data missing. Run `pnpm --filter @erfolg/db seed` first.');
  }
  return { erfolgId: erfolg[0].id, demoId: demo[0].id };
}
