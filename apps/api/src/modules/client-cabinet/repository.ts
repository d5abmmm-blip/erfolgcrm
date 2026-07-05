/**
 * Client cabinet repository (Stage 10'.H).
 *
 * Чистые БД-операции для:
 *   • client_users — учётки сотрудников клиентов
 *   • client_sessions — отдельные сессии кабинета
 *   • read-only выборки tickets/assets/invoices/contracts по client_id
 *
 * RLS: все запросы через withTenantTx → tenant_id всегда фильтруется политикой.
 * Дополнительно к этому фильтруем по client_id в outbound запросах
 * (assets/tickets/invoices/contracts), чтобы каждый клиент видел только свои
 * данные внутри одного tenant'а.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { hash, verify } from 'argon2';
import {
  assets,
  clientSessions,
  clientUsers,
  clients,
  consentRecords,
  contracts,
  invoices,
  payments,
  ticketEvents,
  tickets,
  users,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { getRedis } from '../../lib/redis';

/**
 * 7 дней — как у сотрудников (политика 152-ФЗ: короткие сессии с продлением
 * «по активности» через touchClientSession, см. trpc/context.ts).
 */
export const CLIENT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
/** Порог синхронизации expires_at в БД (не чаще раза в час), как у staff-сессий. */
const CLIENT_TOUCH_DB_THRESHOLD_SECONDS = 60 * 60;

/**
 * 152-ФЗ — фиксированное значение subject_type для записей consent_records,
 * относящихся к учёткам кабинета клиента (отдельно от subject_type='user' = staff
 * и subject_type='client' = клиент-юрлицо/физлицо в clients).
 */
const CLIENT_USER_SUBJECT_TYPE = 'client_user';

/** Версия документа политики, действительной на момент имплементации. */
const POLICY_VERSION_PDN = '1.0';

/** Текст согласия, фиксируется для неоспоримости (152-ФЗ ст.9 ч.4). */
const PDN_CONSENT_TEXT =
  'Согласие на обработку персональных данных в личном кабинете клиента ' +
  'ООО "Эрфольг" в объёме email, ФИО, должности, телефона и истории заявок ' +
  'для целей выполнения договора оказания услуг по ремонту и обслуживанию медтехники.';

export interface ClientUserRow {
  id: string;
  clientId: string;
  email: string;
  fullName: string;
  position: string | null;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function toRow(u: typeof clientUsers.$inferSelect): ClientUserRow {
  return {
    id: u.id,
    clientId: u.clientId,
    email: u.email,
    fullName: u.fullName,
    position: u.position,
    phone: u.phone,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export class ClientUserConflictError extends Error {
  constructor() {
    super('Email уже используется');
  }
}

function normEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface CreateClientUserInput {
  email: string;
  password: string;
  fullName: string;
  position?: string | null;
  phone?: string | null;
}

export async function createClientUser(
  db: Db,
  tenantId: string,
  clientId: string,
  input: CreateClientUserInput,
): Promise<ClientUserRow> {
  const email = normEmail(input.email);
  const passwordHash = await hash(input.password);

  return withTenantTx(db, tenantId, async (tx) => {
    const dup = await tx
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(
        and(
          sql`lower(${clientUsers.email}) = ${email}`,
          isNull(clientUsers.deletedAt),
        ),
      )
      .limit(1);
    if (dup[0]) throw new ClientUserConflictError();

    const [created] = await tx
      .insert(clientUsers)
      .values({
        tenantId,
        clientId,
        email,
        passwordHash,
        fullName: input.fullName.trim(),
        position: input.position?.trim() || null,
        phone: input.phone?.trim() || null,
      })
      .returning();
    if (!created) throw new Error('Failed to create client user');
    return toRow(created);
  });
}

export async function listClientUsersForClient(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<ClientUserRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(clientUsers)
      .where(
        and(eq(clientUsers.clientId, clientId), isNull(clientUsers.deletedAt)),
      )
      .orderBy(clientUsers.fullName);
    return rows.map(toRow);
  });
}

export async function findClientUserByEmail(
  db: Db,
  tenantId: string,
  email: string,
): Promise<(typeof clientUsers.$inferSelect) | null> {
  const lowered = normEmail(email);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(clientUsers)
      .where(
        and(
          sql`lower(${clientUsers.email}) = ${lowered}`,
          isNull(clientUsers.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function getClientUserById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<(typeof clientUsers.$inferSelect) | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(clientUsers)
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function setClientUserActive(
  db: Db,
  tenantId: string,
  id: string,
  isActive: boolean,
): Promise<ClientUserRow | null> {
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [updated] = await tx
      .update(clientUsers)
      .set({ isActive })
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .returning();

    let tokensToDrop: string[] = [];
    if (!isActive) {
      const active = await tx
        .select({ token: clientSessions.sessionToken })
        .from(clientSessions)
        .where(
          and(
            eq(clientSessions.clientUserId, id),
            isNull(clientSessions.revokedAt),
          ),
        );
      tokensToDrop = active.map((s) => s.token);
      await tx
        .update(clientSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(clientSessions.clientUserId, id),
            isNull(clientSessions.revokedAt),
          ),
        );
      // 152-ФЗ: отзываем активные согласия при блокировке учётки
      await tx
        .update(consentRecords)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(consentRecords.subjectType, CLIENT_USER_SUBJECT_TYPE),
            eq(consentRecords.subjectId, id),
            isNull(consentRecords.revokedAt),
          ),
        );
    }
    return { row: updated ? toRow(updated) : null, tokensToDrop };
  });
  if (result.tokensToDrop.length > 0) {
    const redis = getRedis();
    await Promise.all(result.tokensToDrop.map((t) => redis.del(REDIS_KEY(t))));
  }
  return result.row;
}

export async function softDeleteClientUser(
  db: Db,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [u] = await tx
      .update(clientUsers)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .returning({ id: clientUsers.id });
    let tokens: string[] = [];
    if (u) {
      const active = await tx
        .select({ token: clientSessions.sessionToken })
        .from(clientSessions)
        .where(
          and(
            eq(clientSessions.clientUserId, id),
            isNull(clientSessions.revokedAt),
          ),
        );
      tokens = active.map((s) => s.token);
      await tx
        .update(clientSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(clientSessions.clientUserId, id),
            isNull(clientSessions.revokedAt),
          ),
        );
      // 152-ФЗ: отзыв активных согласий при удалении учётки
      await tx
        .update(consentRecords)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(consentRecords.subjectType, CLIENT_USER_SUBJECT_TYPE),
            eq(consentRecords.subjectId, id),
            isNull(consentRecords.revokedAt),
          ),
        );
    }
    return { ok: Boolean(u), tokens };
  });
  if (result.tokens.length > 0) {
    const redis = getRedis();
    await Promise.all(result.tokens.map((t) => redis.del(REDIS_KEY(t))));
  }
  return result.ok;
}

export async function resetClientUserPassword(
  db: Db,
  tenantId: string,
  id: string,
  newPassword: string,
): Promise<boolean> {
  const passwordHash = await hash(newPassword);
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [updated] = await tx
      .update(clientUsers)
      .set({ passwordHash })
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .returning({ id: clientUsers.id });
    if (!updated) return { ok: false as const, tokens: [] as string[] };
    const active = await tx
      .select({ token: clientSessions.sessionToken })
      .from(clientSessions)
      .where(
        and(
          eq(clientSessions.clientUserId, id),
          isNull(clientSessions.revokedAt),
        ),
      );
    await tx
      .update(clientSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(clientSessions.clientUserId, id),
          isNull(clientSessions.revokedAt),
        ),
      );
    return { ok: true as const, tokens: active.map((s) => s.token) };
  });
  if (result.tokens.length > 0) {
    const redis = getRedis();
    await Promise.all(result.tokens.map((t) => redis.del(REDIS_KEY(t))));
  }
  return result.ok;
}

export class ClientWrongPasswordError extends Error {
  constructor() {
    super('Текущий пароль неверный');
  }
}

export async function changeMyClientPassword(
  db: Db,
  tenantId: string,
  id: string,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const newHash = await hash(newPassword);
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [current] = await tx
      .select()
      .from(clientUsers)
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .limit(1);
    if (!current) return { ok: false as const, tokens: [] as string[] };

    const ok = await verify(current.passwordHash, oldPassword);
    if (!ok) throw new ClientWrongPasswordError();

    await tx
      .update(clientUsers)
      .set({ passwordHash: newHash })
      .where(eq(clientUsers.id, id));

    const active = await tx
      .select({ token: clientSessions.sessionToken })
      .from(clientSessions)
      .where(
        and(
          eq(clientSessions.clientUserId, id),
          isNull(clientSessions.revokedAt),
        ),
      );
    await tx
      .update(clientSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(clientSessions.clientUserId, id),
          isNull(clientSessions.revokedAt),
        ),
      );
    return { ok: true as const, tokens: active.map((s) => s.token) };
  });
  if (result.tokens.length > 0) {
    const redis = getRedis();
    await Promise.all(result.tokens.map((t) => redis.del(REDIS_KEY(t))));
  }
  return result.ok;
}

export async function updateMyClientProfile(
  db: Db,
  tenantId: string,
  id: string,
  patch: { fullName?: string; phone?: string | null; position?: string | null },
): Promise<ClientUserRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Partial<typeof clientUsers.$inferInsert> = {};
    if (patch.fullName !== undefined) set.fullName = patch.fullName.trim();
    if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
    if (patch.position !== undefined) set.position = patch.position?.trim() || null;
    if (Object.keys(set).length === 0) {
      const [cur] = await tx
        .select()
        .from(clientUsers)
        .where(eq(clientUsers.id, id))
        .limit(1);
      return cur ? toRow(cur) : null;
    }
    const [updated] = await tx
      .update(clientUsers)
      .set(set)
      .where(and(eq(clientUsers.id, id), isNull(clientUsers.deletedAt)))
      .returning();
    return updated ? toRow(updated) : null;
  });
}

/* ───────────── Sessions ─────────────
 *
 * Хранение в Redis (быстрый lookup по token без RLS-конфликтов) +
 * дублируем в client_sessions для аудита и принудительного logout.
 * Аналогично staff-сессиям (lib/session.ts).
 */

const REDIS_KEY = (token: string) => `client_session:${token}`;

export interface CachedClientSession {
  tenantId: string;
  clientUserId: string;
  clientId: string;
  email: string;
  fullName: string;
  expiresAt: number;
}

export async function createClientSession(
  db: Db,
  tenantId: string,
  clientUserId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  // 256 бит случайности (uuidv7 содержит предсказуемый timestamp — не годится).
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CLIENT_SESSION_TTL_SECONDS * 1000);

  const cached = await withTenantTx(db, tenantId, async (tx) => {
    const [u] = await tx
      .select()
      .from(clientUsers)
      .where(eq(clientUsers.id, clientUserId))
      .limit(1);
    if (!u) throw new Error('Client user not found at session create');

    await tx.insert(clientSessions).values({
      tenantId,
      clientUserId,
      sessionToken: token,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      expiresAt,
    });
    await tx
      .update(clientUsers)
      .set({ lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null })
      .where(eq(clientUsers.id, clientUserId));
    return {
      tenantId,
      clientUserId,
      clientId: u.clientId,
      email: u.email,
      fullName: u.fullName,
      expiresAt: expiresAt.getTime(),
    } satisfies CachedClientSession;
  });

  await getRedis().set(
    REDIS_KEY(token),
    JSON.stringify(cached),
    'EX',
    CLIENT_SESSION_TTL_SECONDS,
  );
  return { token, expiresAt };
}

export type ResolvedClientSession = CachedClientSession;

/**
 * Разрешает токен сессии в client-user. Читает из Redis (быстро, без RLS).
 * При отсутствии в Redis считаем сессию протухшей (вместо fallback в БД, чтобы
 * не плодить RLS-сложности — поведение симметрично staff-сессиям).
 */
export async function resolveClientSession(
  _db: Db,
  token: string,
): Promise<ResolvedClientSession | null> {
  if (!token) return null;
  const raw = await getRedis().get(REDIS_KEY(token));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as CachedClientSession;
    if (data.expiresAt < Date.now()) {
      await getRedis().del(REDIS_KEY(token));
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Rolling-продление клиентской сессии «по активности» — зеркало touchSession
 * для staff (lib/session.ts): Redis продлевается на полный TTL при каждом
 * запросе, БД (client_sessions.expires_at) — не чаще раза в час.
 */
export async function touchClientSession(db: Db, token: string): Promise<void> {
  if (!token) return;
  const redis = getRedis();
  const raw = await redis.get(REDIS_KEY(token));
  if (!raw) return;
  let data: CachedClientSession;
  try {
    data = JSON.parse(raw) as CachedClientSession;
  } catch {
    return;
  }
  const now = Date.now();
  if (data.expiresAt < now) {
    await redis.del(REDIS_KEY(token));
    return;
  }
  const newExpiresAt = now + CLIENT_SESSION_TTL_SECONDS * 1000;
  const updated: CachedClientSession = { ...data, expiresAt: newExpiresAt };
  await redis.set(REDIS_KEY(token), JSON.stringify(updated), 'EX', CLIENT_SESSION_TTL_SECONDS);

  const remainingSec = Math.max(0, Math.floor((data.expiresAt - now) / 1000));
  if (remainingSec < CLIENT_SESSION_TTL_SECONDS - CLIENT_TOUCH_DB_THRESHOLD_SECONDS) {
    await withTenantTx(db, data.tenantId, async (tx) => {
      await tx
        .update(clientSessions)
        .set({ expiresAt: new Date(newExpiresAt) })
        .where(eq(clientSessions.sessionToken, token));
    });
  }
}

export async function revokeClientSession(
  db: Db,
  tenantId: string,
  token: string,
): Promise<void> {
  await getRedis().del(REDIS_KEY(token));
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(clientSessions)
      .set({ revokedAt: new Date() })
      .where(eq(clientSessions.sessionToken, token));
  });
}

/* ───────────── Read-only бизнес-выборки кабинета ───────────── */

export interface MyAssetRow {
  id: string;
  model: string;
  manufacturer: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
  location: string | null;
  lifecycleStatus: string;
  riskClass: string | null;
}

export async function getMyAssets(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<MyAssetRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: assets.id,
        model: assets.model,
        manufacturer: assets.manufacturer,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        location: assets.location,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
      })
      .from(assets)
      .where(
        and(eq(assets.ownerClientId, clientId), isNull(assets.deletedAt)),
      )
      .orderBy(assets.model);
    return rows;
  });
}

export async function getMyAssetById(
  db: Db,
  tenantId: string,
  clientId: string,
  assetId: string,
): Promise<MyAssetRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: assets.id,
        model: assets.model,
        manufacturer: assets.manufacturer,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        location: assets.location,
        lifecycleStatus: assets.lifecycleStatus,
        riskClass: assets.riskClass,
      })
      .from(assets)
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.ownerClientId, clientId),
          isNull(assets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface MyTicketRow {
  id: string;
  ticketNumber: string;
  status: string;
  priority: string;
  symptom: string | null;
  receivedAt: Date;
  closedAt: Date | null;
  assetId: string | null;
  assetModel: string | null;
  engineerName: string | null;
}

export async function getMyTickets(
  db: Db,
  tenantId: string,
  clientId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<MyTicketRow[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [eq(tickets.clientId, clientId), isNull(tickets.deletedAt)];
    if (opts.status) {
      filters.push(eq(tickets.status, opts.status as 'received'));
    }
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        symptom: tickets.symptom,
        receivedAt: tickets.receivedAt,
        closedAt: tickets.closedAt,
        assetId: tickets.assetId,
        assetModel: assets.model,
        engineerName: users.fullName,
      })
      .from(tickets)
      .leftJoin(assets, eq(assets.id, tickets.assetId))
      .leftJoin(users, eq(users.id, tickets.assignedEngineerId))
      .where(and(...filters))
      .orderBy(desc(tickets.receivedAt))
      .limit(limit);
    return rows;
  });
}

export async function getMyTicketById(
  db: Db,
  tenantId: string,
  clientId: string,
  ticketId: string,
): Promise<
  | (MyTicketRow & {
      cancelledAt: Date | null;
      waitingForPart: boolean;
      events: Array<{ id: string; type: string; createdAt: Date; payload: unknown }>;
    })
  | null
> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        symptom: tickets.symptom,
        receivedAt: tickets.receivedAt,
        closedAt: tickets.closedAt,
        cancelledAt: tickets.cancelledAt,
        waitingForPart: tickets.waitingForPart,
        assetId: tickets.assetId,
        assetModel: assets.model,
        engineerName: users.fullName,
      })
      .from(tickets)
      .leftJoin(assets, eq(assets.id, tickets.assetId))
      .leftJoin(users, eq(users.id, tickets.assignedEngineerId))
      .where(
        and(
          eq(tickets.id, ticketId),
          eq(tickets.clientId, clientId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;

    // Только смены статуса: из них строится трек-таймлайн. Прочие события (note с
    // внутренним комментарием менеджера, assignment_change с UUID инженеров и т.п.)
    // клиенту не нужны и НЕ должны уходить в его браузер даже в сыром ответе.
    const events = await tx
      .select({
        id: ticketEvents.id,
        type: ticketEvents.type,
        createdAt: ticketEvents.createdAt,
        payload: ticketEvents.payload,
      })
      .from(ticketEvents)
      .where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.type, 'status_change')))
      .orderBy(ticketEvents.createdAt);

    return { ...row, events };
  });
}

export interface MyInvoiceRow {
  id: string;
  invoiceNumber: string;
  status: string;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
  issueDate: string;
  dueDate: string;
  createdAt: Date;
}

export async function getMyInvoices(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<MyInvoiceRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        status: invoices.status,
        totalAmountKopecks: invoices.totalAmountKopecks,
        paidAmountKopecks: invoices.paidAmountKopecks,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(
        and(eq(invoices.clientId, clientId), isNull(invoices.deletedAt)),
      )
      .orderBy(desc(invoices.createdAt));
    return rows.map((r) => ({
      ...r,
      totalAmountKopecks: r.totalAmountKopecks.toString(),
      paidAmountKopecks: r.paidAmountKopecks.toString(),
    }));
  });
}

export interface MyContractRow {
  id: string;
  contractNumber: string;
  contractDate: string;
  type: string;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
}

export async function getMyContracts(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<MyContractRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: contracts.id,
        contractNumber: contracts.contractNumber,
        contractDate: contracts.contractDate,
        type: contracts.type,
        status: contracts.status,
        validFrom: contracts.validFrom,
        validUntil: contracts.validUntil,
      })
      .from(contracts)
      .where(
        and(eq(contracts.clientId, clientId), isNull(contracts.deletedAt)),
      )
      .orderBy(desc(contracts.contractDate));
    return rows;
  });
}

/** Получить displayName клиента — для шапки кабинета. */
export async function getClientDisplayName(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ name: clients.displayName })
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .limit(1);
    return rows[0]?.name ?? null;
  });
}

/* ───────────── 152-ФЗ: согласия и DSAR ───────────── */

/**
 * Записывает согласие на обработку ПДн при первом успешном входе клиента.
 * Идемпотентно: если активная запись (revoked_at IS NULL) уже существует — возвращает её
 * без вставки, что соответствует "согласие уже дано и не отозвано".
 *
 * @returns true если новая запись создана, false если согласие уже было активно.
 */
export async function recordClientConsentIfMissing(
  db: Db,
  tenantId: string,
  subjectId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await tx
      .select({ id: consentRecords.id })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.subjectType, CLIENT_USER_SUBJECT_TYPE),
          eq(consentRecords.subjectId, subjectId),
          eq(consentRecords.consentType, 'pdn_processing'),
          isNull(consentRecords.revokedAt),
        ),
      )
      .limit(1);
    if (existing[0]) return false;

    await tx.insert(consentRecords).values({
      tenantId,
      subjectType: CLIENT_USER_SUBJECT_TYPE,
      subjectId,
      consentType: 'pdn_processing',
      policyVersion: POLICY_VERSION_PDN,
      consentText: PDN_CONSENT_TEXT,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    });
    return true;
  });
}

/**
 * Отзывает все активные согласия для subject (client_user).
 * Используется при DSAR-удалении и блокировке учётки.
 */
export async function revokeClientConsents(
  db: Db,
  tenantId: string,
  subjectId: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(consentRecords)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(consentRecords.subjectType, CLIENT_USER_SUBJECT_TYPE),
          eq(consentRecords.subjectId, subjectId),
          isNull(consentRecords.revokedAt),
        ),
      );
  });
}

/**
 * Возвращает все активные (не отозванные) согласия subject — для DSAR-экспорта.
 */
export interface ConsentRow {
  id: string;
  consentType: string;
  policyVersion: string;
  consentText: string;
  givenAt: Date;
  revokedAt: Date | null;
}

export async function getClientConsents(
  db: Db,
  tenantId: string,
  subjectId: string,
): Promise<ConsentRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: consentRecords.id,
        consentType: consentRecords.consentType,
        policyVersion: consentRecords.policyVersion,
        consentText: consentRecords.consentText,
        givenAt: consentRecords.givenAt,
        revokedAt: consentRecords.revokedAt,
      })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.subjectType, CLIENT_USER_SUBJECT_TYPE),
          eq(consentRecords.subjectId, subjectId),
        ),
      )
      .orderBy(desc(consentRecords.givenAt));
    return rows;
  });
}

/**
 * Принудительно завершает ВСЕ активные сессии клиента (Redis + БД).
 * Используется при DSAR-удалении аккаунта и при reset password.
 */
export async function revokeAllClientSessions(
  db: Db,
  tenantId: string,
  clientUserId: string,
): Promise<void> {
  const tokens = await withTenantTx(db, tenantId, async (tx) => {
    const active = await tx
      .select({ token: clientSessions.sessionToken })
      .from(clientSessions)
      .where(
        and(
          eq(clientSessions.clientUserId, clientUserId),
          isNull(clientSessions.revokedAt),
        ),
      );
    await tx
      .update(clientSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(clientSessions.clientUserId, clientUserId),
          isNull(clientSessions.revokedAt),
        ),
      );
    return active.map((s) => s.token);
  });
  if (tokens.length > 0) {
    const redis = getRedis();
    await Promise.all(tokens.map((t) => redis.del(REDIS_KEY(t))));
  }
}

/**
 * DSAR — отметка о запросе удаления аккаунта.
 * Реальное физическое удаление выполняется отдельным cron'ом за пределами обязательного
 * срока хранения (5 лет по бухучёту). Здесь только маркер + блокировка.
 */
export async function markClientUserDeletionRequested(
  db: Db,
  tenantId: string,
  clientUserId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [updated] = await tx
      .update(clientUsers)
      .set({ deletionRequestedAt: new Date(), isActive: false })
      .where(
        and(
          eq(clientUsers.id, clientUserId),
          isNull(clientUsers.deletedAt),
        ),
      )
      .returning({ id: clientUsers.id });
    return Boolean(updated);
  });
}

/* ───────────── DSAR exports (профиль/тикеты/счета/платежи) ───────────── */

export interface DsarTicketRow {
  id: string;
  ticketNumber: string;
  status: string;
  priority: string;
  symptom: string | null;
  notes: string | null;
  receivedAt: Date;
  closedAt: Date | null;
  cancelledAt: Date | null;
  assetId: string | null;
}

export async function getMyTicketsForExport(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<DsarTicketRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        priority: tickets.priority,
        symptom: tickets.symptom,
        notes: tickets.notes,
        receivedAt: tickets.receivedAt,
        closedAt: tickets.closedAt,
        cancelledAt: tickets.cancelledAt,
        assetId: tickets.assetId,
      })
      .from(tickets)
      .where(
        and(eq(tickets.clientId, clientId), isNull(tickets.deletedAt)),
      )
      .orderBy(desc(tickets.receivedAt));
    return rows;
  });
}

export interface DsarPaymentRow {
  id: string;
  ticketId: string;
  invoiceId: string | null;
  amountKopecks: string;
  method: string;
  paidAt: Date;
  comment: string | null;
}

export async function getMyPaymentsForExport(
  db: Db,
  tenantId: string,
  clientId: string,
): Promise<DsarPaymentRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        ticketId: payments.ticketId,
        invoiceId: payments.invoiceId,
        amountKopecks: payments.amountKopecks,
        method: payments.method,
        paidAt: payments.paidAt,
        comment: payments.comment,
      })
      .from(payments)
      .innerJoin(tickets, eq(tickets.id, payments.ticketId))
      .where(
        and(eq(tickets.clientId, clientId), isNull(tickets.deletedAt)),
      )
      .orderBy(desc(payments.paidAt));
    return rows.map((r) => ({
      ...r,
      amountKopecks: r.amountKopecks.toString(),
    }));
  });
}

export interface DsarProfileRow {
  id: string;
  email: string;
  fullName: string;
  position: string | null;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletionRequestedAt: Date | null;
  clientId: string;
  clientDisplayName: string | null;
}

export async function getMyProfileForExport(
  db: Db,
  tenantId: string,
  clientUserId: string,
): Promise<DsarProfileRow | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: clientUsers.id,
        email: clientUsers.email,
        fullName: clientUsers.fullName,
        position: clientUsers.position,
        phone: clientUsers.phone,
        isActive: clientUsers.isActive,
        lastLoginAt: clientUsers.lastLoginAt,
        createdAt: clientUsers.createdAt,
        deletionRequestedAt: clientUsers.deletionRequestedAt,
        clientId: clientUsers.clientId,
        clientDisplayName: clients.displayName,
      })
      .from(clientUsers)
      .leftJoin(clients, eq(clients.id, clientUsers.clientId))
      .where(
        and(
          eq(clientUsers.id, clientUserId),
          isNull(clientUsers.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}
