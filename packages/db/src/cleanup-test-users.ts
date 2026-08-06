/**
 * One-off cleanup: убирает пользователей-зомби, оставшихся после прогонов
 * `users-crud.test.ts` с прерванной cleanup-фазой. Запускается вручную, когда
 * `cross-tenant.test > erfolg имеет 3 пользователей` падает с 4 строками.
 *
 *   pnpm --filter @erfolg/db tsx src/cleanup-test-users.ts
 */
import 'dotenv/config';
import { like, or, eq } from 'drizzle-orm';
import { makeDb } from './client';
import { users } from './schema';

const DATABASE_URL =
  process.env.DATABASE_OWNER_URL ??
  process.env.DATABASE_URL ??
  'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev';

async function main() {
  const db = makeDb(DATABASE_URL);
  const removed = await db
    .delete(users)
    .where(or(like(users.username, 'test_crud_%'), eq(users.username, 'smoke_user')))
    .returning({ username: users.username });
  console.info(
    `Removed ${removed.length} stale test users:`,
    removed.map((r) => r.username),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
