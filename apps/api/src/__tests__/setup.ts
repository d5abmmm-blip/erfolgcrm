/**
 * Setup для тестов: загружает .env, проверяет что seed-данные есть в БД.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';

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
