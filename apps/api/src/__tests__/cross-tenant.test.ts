/**
 * Cross-Tenant Security Test Suite.
 *
 * Главное: при ЛЮБОЙ попытке tenant A прочитать данные tenant B — должен быть отказ.
 * Защита эшелонированная:
 *   1. Drizzle-helper фильтрует по tenant_id из контекста (первый слой)
 *   2. PostgreSQL RLS возвращает 0 строк если tenant_id не задан или не совпадает (второй слой)
 *   3. tRPC middleware tenantProcedure требует tenant в context (третий слой)
 *
 * Если этот suite упадёт — нельзя мерджить в main.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, users, sessions, auditLogs, withTenantTx, withoutTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

describe('RLS — запрос без app.current_tenant_id', () => {
  it('users: возвращает 0 строк (RLS защищает)', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(users));
    expect(rows.length).toBe(0);
  });

  it('sessions: возвращает 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(sessions));
    expect(rows.length).toBe(0);
  });

  it('audit_logs: возвращает 0 строк', async () => {
    const rows = await withoutTenantTx(getDb(), async (tx) => tx.select().from(auditLogs));
    expect(rows.length).toBe(0);
  });
});

describe('RLS — withTenantTx(erfolg) видит ТОЛЬКО erfolg', () => {
  it('users: только пользователи erfolg', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(users));
    expect(rows.length).toBeGreaterThan(0);
    for (const u of rows) expect(u.tenantId).toBe(erfolgId);
  });

  it('users: erfolg НЕ видит demo', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(users));
    expect(rows.every((u) => u.tenantId !== demoId)).toBe(true);
  });
});

describe('RLS — withTenantTx(demo) видит ТОЛЬКО demo', () => {
  it('users: только пользователи demo', async () => {
    const rows = await withTenantTx(getDb(), demoId, async (tx) => tx.select().from(users));
    expect(rows.length).toBeGreaterThan(0);
    for (const u of rows) expect(u.tenantId).toBe(demoId);
  });
});

describe('RLS — попытка чтения чужого ID (атака)', () => {
  it('SELECT user erfolg по ID из контекста demo → 0 строк', async () => {
    // Получаем erfolg-user под erfolg-контекстом
    const [erfolgUser] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(users).where(eq(users.username, 'director')).limit(1),
    );
    expect(erfolgUser).toBeDefined();
    if (!erfolgUser) return;

    // Пытаемся прочитать его под demo-контекстом
    const stolen = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(users).where(eq(users.id, erfolgUser.id)),
    );
    expect(stolen.length).toBe(0);
  });

  it('UPDATE чужого user под другим tenant: 0 строк затронуто', async () => {
    const [erfolgUser] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(users).where(eq(users.username, 'engineer')).limit(1),
    );
    if (!erfolgUser) throw new Error('seed missing');

    // demo пытается обновить email erfolg-юзера
    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx
        .update(users)
        .set({ email: 'pwned@hacker.com' })
        .where(eq(users.id, erfolgUser.id))
        .returning({ id: users.id }),
    );
    expect(result.length).toBe(0);

    // Убеждаемся что email НЕ изменился
    const [unchanged] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, erfolgUser.id)),
    );
    expect(unchanged?.email).not.toBe('pwned@hacker.com');
  });

  it('DELETE чужого user под другим tenant: 0 строк удалено', async () => {
    const [erfolgUser] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(users).where(eq(users.username, 'dispatcher')).limit(1),
    );
    if (!erfolgUser) throw new Error('seed missing');

    const result = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.delete(users).where(eq(users.id, erfolgUser.id)).returning({ id: users.id }),
    );
    expect(result.length).toBe(0);

    // Юзер всё ещё там
    const [stillThere] = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(users).where(eq(users.id, erfolgUser.id)),
    );
    expect(stillThere).toBeDefined();
  });
});

describe('RLS — INSERT с подменённым tenant_id блокируется', () => {
  it('INSERT user в demo с tenant_id=erfolg должен провалиться', async () => {
    // Под demo-контекстом пробуем вставить юзера с tenant_id=erfolg
    await expect(
      withTenantTx(getDb(), demoId, async (tx) =>
        tx.insert(users).values({
          tenantId: erfolgId, // подменяем tenant!
          username: 'attacker',
          fullName: 'Attacker',
          role: 'director',
          passwordHash: 'fake',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('RLS — функция current_tenant_id() корректно реагирует на set_config', () => {
  it('возвращает заданный tenant_id', async () => {
    const result = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.execute(sql`SELECT current_tenant_id() AS tid`),
    );
    const rows = result as unknown as Array<{ tid: string }>;
    expect(rows[0]?.tid).toBe(erfolgId);
  });

  it('возвращает NULL если не задан', async () => {
    const result = await withoutTenantTx(getDb(), async (tx) =>
      tx.execute(sql`SELECT current_tenant_id() AS tid`),
    );
    const rows = result as unknown as Array<{ tid: string | null }>;
    expect(rows[0]?.tid).toBeNull();
  });
});

describe('RLS — sessions изолированы', () => {
  it('sessions erfolg недоступны из demo', async () => {
    // Под erfolg создаём сессию
    const inserted = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx
        .insert(sessions)
        .values({
          tenantId: erfolgId,
          userId: (await tx.select().from(users).where(eq(users.username, 'director')).limit(1))[0]!
            .id,
          sessionToken: `test-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .returning({ id: sessions.id }),
    );
    const sid = inserted[0]!.id;

    // Под demo пытаемся прочитать
    const stolen = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(sessions).where(eq(sessions.id, sid)),
    );
    expect(stolen.length).toBe(0);

    // Чистим
    await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.delete(sessions).where(eq(sessions.id, sid)),
    );
  });
});

describe('RLS — audit_logs изолированы', () => {
  it('audit erfolg не видны demo', async () => {
    const stamp = `audit-test-${Date.now()}`;
    await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.insert(auditLogs).values({
        tenantId: erfolgId,
        userId: null,
        action: 'login_failed',
        entityType: 'test',
        entityId: stamp,
      }),
    );

    const fromDemo = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.entityId, stamp)),
    );
    expect(fromDemo.length).toBe(0);

    const fromErfolg = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.entityId, stamp)),
    );
    expect(fromErfolg.length).toBe(1);

    // cleanup
    await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.delete(auditLogs).where(eq(auditLogs.entityId, stamp)),
    );
  });
});

describe('RLS — withTenantTx с несуществующим tenant_id', () => {
  it('возвращает 0 строк для users (нет данных под этим tenant)', async () => {
    const fakeTenantId = '00000000-0000-7000-0000-000000000000';
    const rows = await withTenantTx(getDb(), fakeTenantId, async (tx) => tx.select().from(users));
    expect(rows.length).toBe(0);
  });

  it('бросает ошибку при пустом tenant_id', async () => {
    await expect(
      withTenantTx(getDb(), '', async (tx) => tx.select().from(users)),
    ).rejects.toThrow(/tenantId is required/);
  });
});

describe('RLS — конкурентность транзакций (set_config LOCAL не утекает между подключениями)', () => {
  it('параллельные withTenantTx erfolg + demo не путают данные', async () => {
    const [erfolgUsers, demoUsers] = await Promise.all([
      withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(users)),
      withTenantTx(getDb(), demoId, async (tx) => tx.select().from(users)),
    ]);
    expect(erfolgUsers.every((u) => u.tenantId === erfolgId)).toBe(true);
    expect(demoUsers.every((u) => u.tenantId === demoId)).toBe(true);
    expect(erfolgUsers.length).toBeGreaterThan(0);
    expect(demoUsers.length).toBeGreaterThan(0);
  });

  it('после транзакции set_config сбрасывается (LOCAL)', async () => {
    await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(users));
    // Следующий запрос вне транзакции — set_config должен быть пуст
    const after = await withoutTenantTx(getDb(), async (tx) =>
      tx.execute(sql`SELECT current_tenant_id() AS tid`),
    );
    const rows = after as unknown as Array<{ tid: string | null }>;
    expect(rows[0]?.tid).toBeNull();
  });
});

describe('RLS — sanity на seed-данных', () => {
  it('erfolg имеет 3 пользователей (director, dispatcher, engineer)', async () => {
    const rows = await withTenantTx(getDb(), erfolgId, async (tx) => tx.select().from(users));
    expect(rows.length).toBe(3);
    const usernames = rows.map((r) => r.username).sort();
    expect(usernames).toEqual(['director', 'dispatcher', 'engineer']);
  });

  it('demo имеет 3 пользователей', async () => {
    const rows = await withTenantTx(getDb(), demoId, async (tx) => tx.select().from(users));
    expect(rows.length).toBe(3);
  });

  it('тоже username "director" в обоих tenant — это OK', async () => {
    const e = await withTenantTx(getDb(), erfolgId, async (tx) =>
      tx.select().from(users).where(eq(users.username, 'director')),
    );
    const d = await withTenantTx(getDb(), demoId, async (tx) =>
      tx.select().from(users).where(eq(users.username, 'director')),
    );
    expect(e.length).toBe(1);
    expect(d.length).toBe(1);
    expect(e[0]!.id).not.toBe(d[0]!.id);
  });
});
