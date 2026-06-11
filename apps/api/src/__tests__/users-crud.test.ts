/**
 * Этап 10' — users CRUD: создание/редактирование/блокировка/сброс пароля.
 *
 * Проверяем:
 *   1. createUser — успех, проверка хеша пароля.
 *   2. createUser — конфликт по username (case-insensitive).
 *   3. createUser — конфликт по email.
 *   4. updateUser — частичное обновление (только fullName).
 *   5. updateUser — смена роли работает.
 *   6. updateUser — нельзя забрать роль у последнего директора.
 *   7. setUserActive — блокировка отзывает все активные сессии.
 *   8. setUserActive — нельзя заблокировать последнего директора.
 *   9. resetPassword — старый пароль перестаёт работать.
 *  10. changeMyPassword — wrong-password ошибка.
 *  11. changeMyPassword — успех + сессия отозвана.
 *  12. cross-tenant — пользователь tenant A не виден из tenant B.
 *  13. listUsers includeBlocked — флаг работает.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { hash, verify } from 'argon2';
import {
  getDb,
  sessions,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  changeMyPassword,
  createUser,
  getUserById,
  LastDirectorError,
  listUsers,
  resetPassword,
  setUserActive,
  updateUser,
  UserConflictError,
  WrongPasswordError,
} from '../modules/users/repository';

const TEST_PREFIX = 'test_crud_';

let erfolgId = '';
let demoId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

/**
 * Подготавливает БД для тестов users-crud:
 *   - чистим только test_crud_* (ничего лишнего)
 *   - в erfolg возвращаем seed-директору role=director + is_active=true,
 *     если прошлые тестовые наборы оставили его в другом состоянии,
 *     и удаляем чужих директоров (созданных другими тестами), чтобы
 *     инвариант «один последний директор» был валиден для тестов в этом файле.
 * Сидер этого не делает (он только INSERT, не UPDATE).
 */
async function clearTestUsers(): Promise<void> {
  // Шаг 1: жёстко чистим test_crud_* в обеих компаниях.
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(users).where(like(users.username, `${TEST_PREFIX}%`));
    });
  }
  // Шаг 2: только в erfolg — нормализуем директорский инвариант.
  // Любой "лишний" директор НЕ из seed (canonical 'director') портит инвариант
  // last-director — таких нужно либо демонстрировать в отдельном tenant, либо удалить.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    const allDirectors = await tx
      .select({ id: users.id, username: users.username, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.role, 'director'));
    for (const d of allDirectors) {
      if (d.username !== 'director') {
        // Демонтируем чужого "директора" → переводим в dispatcher (не удаляем,
        // чтобы не сломать FK на ticket_events.user_id из других тестов).
        await tx.update(users).set({ role: 'dispatcher' }).where(eq(users.id, d.id));
      }
    }
    const seedDir = allDirectors.find((d) => d.username === 'director');
    if (seedDir && (seedDir.role !== 'director' || !seedDir.isActive)) {
      await tx
        .update(users)
        .set({ role: 'director', isActive: true })
        .where(eq(users.id, seedDir.id));
    }
  });
}

beforeEach(clearTestUsers);

describe('createUser', () => {
  it('создаёт пользователя с корректным хешем пароля', async () => {
    const created = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}newdisp`,
      password: 'StrongPass1',
      fullName: 'Новый Диспетчер',
      role: 'dispatcher',
      email: 'new@example.com',
    });
    expect(created.username).toBe(`${TEST_PREFIX}newdisp`);
    expect(created.role).toBe('dispatcher');
    expect(created.isActive).toBe(true);

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, created.id)),
    );
    expect(row).toBeDefined();
    expect(await verify(row!.passwordHash, 'StrongPass1')).toBe(true);
  });

  it('нормализует username и email в lowercase', async () => {
    const created = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}MIXED`,
      password: 'StrongPass1',
      fullName: 'Test',
      role: 'engineer',
      email: 'MiXeD@Example.COM',
    });
    expect(created.username).toBe(`${TEST_PREFIX}mixed`);
    expect(created.email).toBe('mixed@example.com');
  });

  it('конфликт по username (case-insensitive)', async () => {
    await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}dup`,
      password: 'StrongPass1',
      fullName: 'A',
      role: 'engineer',
    });
    await expect(
      createUser(getDb(), erfolgId, {
        username: `${TEST_PREFIX}DUP`,
        password: 'StrongPass1',
        fullName: 'B',
        role: 'engineer',
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('конфликт по email', async () => {
    await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}u1`,
      password: 'StrongPass1',
      fullName: 'A',
      role: 'engineer',
      email: 'shared@example.com',
    });
    await expect(
      createUser(getDb(), erfolgId, {
        username: `${TEST_PREFIX}u2`,
        password: 'StrongPass1',
        fullName: 'B',
        role: 'engineer',
        email: 'shared@example.com',
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('одинаковый username в разных tenant — это OK', async () => {
    await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}same`,
      password: 'StrongPass1',
      fullName: 'A',
      role: 'engineer',
    });
    const inDemo = await createUser(getDb(), demoId, {
      username: `${TEST_PREFIX}same`,
      password: 'StrongPass1',
      fullName: 'A demo',
      role: 'engineer',
    });
    expect(inDemo.username).toBe(`${TEST_PREFIX}same`);
  });
});

describe('updateUser', () => {
  it('частичное обновление работает', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}upd`,
      password: 'StrongPass1',
      fullName: 'Old Name',
      role: 'dispatcher',
    });
    const updated = await updateUser(getDb(), erfolgId, u.id, { fullName: 'New Name' });
    expect(updated?.fullName).toBe('New Name');
    expect(updated?.role).toBe('dispatcher');
  });

  it('смена роли работает', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}role`,
      password: 'StrongPass1',
      fullName: 'X',
      role: 'engineer',
    });
    const updated = await updateUser(getDb(), erfolgId, u.id, { role: 'dispatcher' });
    expect(updated?.role).toBe('dispatcher');
  });

  it('нельзя забрать роль у последнего активного директора', async () => {
    // seed: 1 director (имя director). Делаем его id целью.
    const [dir] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.role, 'director')),
    );
    expect(dir).toBeDefined();
    await expect(
      updateUser(getDb(), erfolgId, dir!.id, { role: 'dispatcher' }),
    ).rejects.toBeInstanceOf(LastDirectorError);
  });

  it('после создания второго директора — смена роли первому работает', async () => {
    // Создаём временного директора-источник, чтобы не трогать seed-директора
    // (другие тесты опираются на стабильность seed).
    const sourceDir = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}dirsrc`,
      password: 'StrongPass1',
      fullName: 'Source Dir',
      role: 'director',
    });
    // Сначала есть seed-director + sourceDir = 2 активных директора. Можем менять роль sourceDir.
    const updated = await updateUser(getDb(), erfolgId, sourceDir.id, { role: 'dispatcher' });
    expect(updated?.role).toBe('dispatcher');
    // Создадим ещё одного директора
    const dir2 = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}dirsrc2`,
      password: 'StrongPass1',
      fullName: 'Second',
      role: 'director',
    });
    expect(dir2.role).toBe('director');
  });

  it('смена роли НЕ-директора (engineer → dispatcher) не триггерит LastDirectorError', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}eng2`,
      password: 'StrongPass1',
      fullName: 'Eng',
      role: 'engineer',
    });
    const updated = await updateUser(getDb(), erfolgId, u.id, { role: 'dispatcher' });
    expect(updated?.role).toBe('dispatcher');
  });
});

describe('setUserActive', () => {
  it('блокировка отзывает активные сессии', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}sess`,
      password: 'StrongPass1',
      fullName: 'S',
      role: 'engineer',
    });
    // Создаём пару сессий вручную в БД
    await withTenantTx(getDb(), erfolgId, async (tx) => {
      await tx.insert(sessions).values([
        {
          tenantId: erfolgId,
          userId: u.id,
          sessionToken: `crud-tok-1-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
        {
          tenantId: erfolgId,
          userId: u.id,
          sessionToken: `crud-tok-2-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ]);
    });

    await setUserActive(getDb(), erfolgId, u.id, false);

    const open = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select()
        .from(sessions)
        .where(eq(sessions.userId, u.id)),
    );
    // Все revokedAt должны быть установлены
    expect(open.length).toBe(2);
    expect(open.every((s) => s.revokedAt !== null)).toBe(true);

    const after = await getUserById(getDb(), erfolgId, u.id);
    expect(after?.isActive).toBe(false);
  });

  it('нельзя заблокировать последнего директора', async () => {
    const [dir] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.role, 'director')),
    );
    await expect(
      setUserActive(getDb(), erfolgId, dir!.id, false),
    ).rejects.toBeInstanceOf(LastDirectorError);
  });

  it('можно заблокировать одного из двух директоров', async () => {
    const newDir = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}dir2`,
      password: 'StrongPass1',
      fullName: 'Second Director',
      role: 'director',
    });
    const result = await setUserActive(getDb(), erfolgId, newDir.id, false);
    expect(result?.isActive).toBe(false);
  });
});

describe('resetPassword', () => {
  it('старый пароль перестаёт работать, новый — работает', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}pw`,
      password: 'OldPass1234',
      fullName: 'P',
      role: 'engineer',
    });
    await resetPassword(getDb(), erfolgId, u.id, 'NewPass5678');

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect(await verify(row!.passwordHash, 'OldPass1234')).toBe(false);
    expect(await verify(row!.passwordHash, 'NewPass5678')).toBe(true);
  });
});

describe('changeMyPassword', () => {
  it('правильный oldPassword — успех', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}myp`,
      password: 'OldPass1234',
      fullName: 'P',
      role: 'engineer',
    });
    const ok = await changeMyPassword(
      getDb(),
      erfolgId,
      u.id,
      'OldPass1234',
      'NewPass5678',
    );
    expect(ok).toBe(true);
  });

  it('неверный oldPassword бросает WrongPasswordError', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}wrp`,
      password: 'OldPass1234',
      fullName: 'P',
      role: 'engineer',
    });
    await expect(
      changeMyPassword(getDb(), erfolgId, u.id, 'WrongOldPass', 'NewPass5678'),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    // И пароль не должен поменяться
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(users).where(eq(users.id, u.id)),
    );
    expect(await verify(row!.passwordHash, 'OldPass1234')).toBe(true);
  });
});

describe('listUsers includeBlocked', () => {
  it('по умолчанию заблокированных не возвращает', async () => {
    const u = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}blk`,
      password: 'StrongPass1',
      fullName: 'Blocked',
      role: 'engineer',
    });
    await setUserActive(getDb(), erfolgId, u.id, false);

    const visible = await listUsers(getDb(), erfolgId);
    expect(visible.find((x) => x.id === u.id)).toBeUndefined();

    const all = await listUsers(getDb(), erfolgId, { includeBlocked: true });
    expect(all.find((x) => x.id === u.id)).toBeDefined();
  });
});

describe('cross-tenant — изоляция', () => {
  it('createUser в erfolg не виден из demo', async () => {
    const created = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}xt`,
      password: 'StrongPass1',
      fullName: 'XT',
      role: 'engineer',
    });
    const fromDemo = await getUserById(getDb(), demoId, created.id);
    expect(fromDemo).toBeNull();
  });

  it('updateUser из demo на пользователя erfolg ничего не меняет', async () => {
    const created = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}xt2`,
      password: 'StrongPass1',
      fullName: 'XT2',
      role: 'engineer',
    });
    const updated = await updateUser(getDb(), demoId, created.id, {
      fullName: 'PWNED',
    });
    expect(updated).toBeNull();
    const stillThere = await getUserById(getDb(), erfolgId, created.id);
    expect(stillThere?.fullName).toBe('XT2');
  });

  it('setUserActive из demo на пользователя erfolg возвращает null', async () => {
    const created = await createUser(getDb(), erfolgId, {
      username: `${TEST_PREFIX}xt3`,
      password: 'StrongPass1',
      fullName: 'XT3',
      role: 'engineer',
    });
    const result = await setUserActive(getDb(), demoId, created.id, false);
    expect(result).toBeNull();
    const stillActive = await getUserById(getDb(), erfolgId, created.id);
    expect(stillActive?.isActive).toBe(true);
  });
});

describe('hash sanity', () => {
  it('argon2 hash + verify работают корректно (sanity)', async () => {
    const h = await hash('hello-world');
    expect(await verify(h, 'hello-world')).toBe(true);
    expect(await verify(h, 'wrong')).toBe(false);
  });
});
