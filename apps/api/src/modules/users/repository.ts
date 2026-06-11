/**
 * Users repository — полный CRUD для управления пользователями одной компании.
 *
 * Этап 9.F: list + setHourlyCostRate.
 * Этап 10' (post-pivot): create/update/setActive/resetPassword/changeMyPassword.
 *
 * Инварианты:
 * - username иммутабелен после создания (как в 1С) — менять запрещено.
 * - Пара (tenant_id, username) уникальна (case-insensitive: храним lowercase).
 * - Пара (tenant_id, email) уникальна, если email задан.
 * - Минимум один активный директор должен оставаться — иначе никто не сможет
 *   управлять пользователями. Защита в deactivateUser/changeRole.
 * - Soft delete через deleted_at (152-ФЗ + аудит).
 * - При блокировке/смене пароля все активные сессии пользователя ревокаются.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { hash, verify } from 'argon2';
import { sessions, users, withTenantTx, type Db } from '@erfolg/db';
import { getRedis } from '../../lib/redis';

export type UserRole = 'director' | 'dispatcher' | 'engineer';

export interface UserListRow {
  id: string;
  username: string;
  fullName: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  hourlyCostRateKopecks: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  role: UserRole;
  password: string;
  hourlyCostRateKopecks?: bigint;
}

export interface UpdateUserInput {
  fullName?: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: UserRole;
}

function toRow(u: typeof users.$inferSelect): UserListRow {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    position: u.position,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    hourlyCostRateKopecks: u.hourlyCostRateKopecks.toString(),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export interface ListUsersOpts {
  onlyEngineers?: boolean;
  includeBlocked?: boolean;
}

export async function listUsers(
  db: Db,
  tenantId: string,
  opts: ListUsersOpts = {},
): Promise<UserListRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [isNull(users.deletedAt)];
    if (opts.onlyEngineers) filters.push(eq(users.role, 'engineer'));
    if (!opts.includeBlocked) filters.push(eq(users.isActive, true));
    const rows = await tx
      .select()
      .from(users)
      .where(and(...filters))
      .orderBy(users.fullName);
    return rows.map(toRow);
  });
}

export async function getUserById(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<UserListRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  });
}

function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

export class UserConflictError extends Error {
  constructor(public field: 'username' | 'email') {
    super(field === 'username' ? 'Логин уже занят' : 'Email уже используется');
  }
}

export async function createUser(
  db: Db,
  tenantId: string,
  input: CreateUserInput,
): Promise<UserListRow> {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const passwordHash = await hash(input.password);

  return withTenantTx(db, tenantId, async (tx) => {
    const dupUsername = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, username), isNull(users.deletedAt)))
      .limit(1);
    if (dupUsername[0]) throw new UserConflictError('username');

    if (email) {
      const dupEmail = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)))
        .limit(1);
      if (dupEmail[0]) throw new UserConflictError('email');
    }

    const [created] = await tx
      .insert(users)
      .values({
        tenantId,
        username,
        fullName: input.fullName.trim(),
        position: input.position?.trim() || null,
        email,
        phone: input.phone?.trim() || null,
        role: input.role,
        passwordHash,
        hourlyCostRateKopecks: input.hourlyCostRateKopecks ?? 0n,
        isActive: true,
      })
      .returning();
    if (!created) throw new Error('Failed to create user');
    return toRow(created);
  });
}

async function countActiveDirectorsTx(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  excludeUserId?: string,
): Promise<number> {
  const filters = [
    eq(users.role, 'director'),
    eq(users.isActive, true),
    isNull(users.deletedAt),
  ];
  if (excludeUserId) filters.push(ne(users.id, excludeUserId));
  const rows = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(users)
    .where(and(...filters));
  return Number(rows[0]?.c ?? 0);
}

export class LastDirectorError extends Error {
  constructor() {
    super('Нельзя оставить компанию без активного директора');
  }
}

export async function updateUser(
  db: Db,
  tenantId: string,
  userId: string,
  patch: UpdateUserInput,
): Promise<UserListRow | null> {
  const email = patch.email !== undefined ? normalizeEmail(patch.email) : undefined;

  return withTenantTx(db, tenantId, async (tx) => {
    const [current] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!current) return null;

    if (email !== undefined && email !== null && email !== current.email) {
      const dup = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.email, email), ne(users.id, userId), isNull(users.deletedAt)),
        )
        .limit(1);
      if (dup[0]) throw new UserConflictError('email');
    }

    if (patch.role && patch.role !== 'director' && current.role === 'director') {
      const others = await countActiveDirectorsTx(tx, userId);
      if (others === 0) throw new LastDirectorError();
    }

    const set: Partial<typeof users.$inferInsert> = {};
    if (patch.fullName !== undefined) set.fullName = patch.fullName.trim();
    if (patch.position !== undefined) set.position = patch.position?.trim() || null;
    if (email !== undefined) set.email = email;
    if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
    if (patch.role !== undefined) set.role = patch.role;

    if (Object.keys(set).length === 0) return toRow(current);

    const [updated] = await tx
      .update(users)
      .set(set)
      .where(eq(users.id, userId))
      .returning();
    return updated ? toRow(updated) : null;
  });
}

export async function setUserActive(
  db: Db,
  tenantId: string,
  userId: string,
  isActive: boolean,
): Promise<UserListRow | null> {
  const tokensToRevoke = await withTenantTx(db, tenantId, async (tx) => {
    const [current] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!current) return null;
    if (current.isActive === isActive) return [];

    if (!isActive && current.role === 'director') {
      const others = await countActiveDirectorsTx(tx, userId);
      if (others === 0) throw new LastDirectorError();
    }

    await tx.update(users).set({ isActive }).where(eq(users.id, userId));

    if (!isActive) {
      const active = await tx
        .select({ token: sessions.sessionToken })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      return active.map((s) => s.token);
    }
    return [];
  });

  if (tokensToRevoke === null) return null;

  if (tokensToRevoke.length > 0) {
    const redis = getRedis();
    await Promise.all(tokensToRevoke.map((t) => redis.del(`session:${t}`)));
  }

  return getUserById(db, tenantId, userId);
}

export async function resetPassword(
  db: Db,
  tenantId: string,
  userId: string,
  newPassword: string,
): Promise<boolean> {
  const passwordHash = await hash(newPassword);
  const tokensToRevoke = await withTenantTx(db, tenantId, async (tx) => {
    const [current] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!current) return null;

    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));

    const active = await tx
      .select({ token: sessions.sessionToken })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return active.map((s) => s.token);
  });

  if (tokensToRevoke === null) return false;

  if (tokensToRevoke.length > 0) {
    const redis = getRedis();
    await Promise.all(tokensToRevoke.map((t) => redis.del(`session:${t}`)));
  }
  return true;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Текущий пароль неверный');
  }
}

export async function changeMyPassword(
  db: Db,
  tenantId: string,
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const newHash = await hash(newPassword);
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [current] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    if (!current) return { ok: false as const, tokens: [] as string[] };

    const ok = await verify(current.passwordHash, oldPassword);
    if (!ok) throw new WrongPasswordError();

    await tx.update(users).set({ passwordHash: newHash }).where(eq(users.id, userId));

    const active = await tx
      .select({ token: sessions.sessionToken })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return { ok: true as const, tokens: active.map((s) => s.token) };
  });

  if (!result.ok) return false;
  if (result.tokens.length > 0) {
    const redis = getRedis();
    await Promise.all(result.tokens.map((t) => redis.del(`session:${t}`)));
  }
  return true;
}

export async function updateHourlyCostRate(
  db: Db,
  tenantId: string,
  userId: string,
  newRateKopecks: bigint,
): Promise<UserListRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(users)
      .set({ hourlyCostRateKopecks: newRateKopecks })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  });
}
