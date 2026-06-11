/**
 * Этап 7-A — изоляция push_subscriptions между тенантами.
 *
 * Проверяем:
 *   1. upsertSubscription создаёт строку, listActiveForUser её возвращает.
 *   2. Повторный upsert по тому же endpoint обновляет привязку (нет дублирования по UNIQUE).
 *   3. listActiveForUser чужого tenant'а возвращает пустой массив (RLS).
 *   4. markRevoked → listActive больше не возвращает.
 *   5. deleteByEndpoint удаляет только свою.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { getDb, pushSubscriptions, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  deleteByEndpoint,
  listActiveForUser,
  markRevoked,
  upsertSubscription,
} from '../modules/notifications/repository';

let erfolgId = '';
let demoId = '';
let erfolgUserId = '';
let demoUserId = '';

const TEST_PREFIX = 'https://example-test/';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [eu] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  const [du] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'engineer')).limit(1),
  );
  if (!eu || !du) throw new Error('seed missing engineer');
  erfolgUserId = eu.id;
  demoUserId = du.id;
});

async function clearTestData() {
  for (const t of [erfolgId, demoId]) {
    await withTenantTx(getDb(), t, async (tx) => {
      await tx.delete(pushSubscriptions).where(like(pushSubscriptions.endpoint, `${TEST_PREFIX}%`));
    });
  }
}

function makeInput(suffix: string, userId: string) {
  return {
    userId,
    endpoint: `${TEST_PREFIX}${suffix}`,
    p256dh: 'P256DH_KEY_BASE64URL_ENCODED_VALUE_HERE_FOR_TEST',
    auth: 'AUTH_KEY_BASE64URL_ENCODED_VALUE_HERE_FOR_TEST',
    userAgent: 'vitest',
  };
}

describe('notifications cross-tenant', () => {
  beforeEach(clearTestData);

  it('upsert + list возвращает свою подписку', async () => {
    const input = makeInput('a', erfolgUserId);
    const dto = await upsertSubscription(getDb(), erfolgId, input);
    expect(dto.userId).toBe(erfolgUserId);

    const list = await listActiveForUser(getDb(), erfolgId, erfolgUserId);
    expect(list).toHaveLength(1);
    expect(list[0]?.endpoint).toBe(input.endpoint);
  });

  it('повторный upsert обновляет, не дублирует', async () => {
    await upsertSubscription(getDb(), erfolgId, makeInput('b', erfolgUserId));
    await upsertSubscription(getDb(), erfolgId, makeInput('b', erfolgUserId));
    const list = await listActiveForUser(getDb(), erfolgId, erfolgUserId);
    const filtered = list.filter((s) => s.endpoint === `${TEST_PREFIX}b`);
    expect(filtered).toHaveLength(1);
  });

  it('подписка одного tenant невидима другому tenant (RLS)', async () => {
    await upsertSubscription(getDb(), erfolgId, makeInput('c', erfolgUserId));
    const otherList = await listActiveForUser(getDb(), demoId, erfolgUserId);
    expect(otherList).toHaveLength(0);
  });

  it('markRevoked прячет подписку из listActiveForUser', async () => {
    const input = makeInput('d', erfolgUserId);
    await upsertSubscription(getDb(), erfolgId, input);
    await markRevoked(getDb(), erfolgId, input.endpoint);
    const list = await listActiveForUser(getDb(), erfolgId, erfolgUserId);
    expect(list.find((s) => s.endpoint === input.endpoint)).toBeUndefined();
  });

  it('deleteByEndpoint работает только для своего пользователя', async () => {
    const input = makeInput('e', erfolgUserId);
    await upsertSubscription(getDb(), erfolgId, input);
    const wrongUser = await deleteByEndpoint(getDb(), erfolgId, demoUserId, input.endpoint);
    expect(wrongUser).toBe(false);
    const ok = await deleteByEndpoint(getDb(), erfolgId, erfolgUserId, input.endpoint);
    expect(ok).toBe(true);
  });
});
