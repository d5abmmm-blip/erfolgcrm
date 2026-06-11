/**
 * Repository ticket_kp_versions. Все запросы под withTenantTx (RLS FORCE).
 *
 * Деньги — bigint копейки; в DTO сериализуются строками (паттерн dashboard).
 * version назначается сервером: MAX(version)+1 в той же транзакции, что и INSERT
 * (unique-индекс (tenant, ticket, version) ловит гонку → 23505 → retry на service).
 */
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ticketKpVersions, users, withTenantTx, type Db } from '@erfolg/db';
import type { KpStatus } from '@erfolg/shared';

export interface KpVersionDto {
  id: string;
  ticketId: string;
  version: number;
  status: KpStatus;
  worksAmountKopecks: string;
  partsAmountKopecks: string;
  totalAmountKopecks: string;
  description: string;
  sentAt: Date | null;
  respondedAt: Date | null;
  rejectionReason: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date;
}

export interface CreateKpInput {
  ticketId: string;
  status?: KpStatus;
  worksAmountKopecks: bigint;
  partsAmountKopecks: bigint;
  description: string;
  createdByUserId: string;
}

export interface UpdateKpPatch {
  status?: KpStatus;
  worksAmountKopecks?: bigint;
  partsAmountKopecks?: bigint;
  description?: string;
  rejectionReason?: string | null;
}

interface JoinedRow {
  kp: typeof ticketKpVersions.$inferSelect;
  createdByName: string | null;
}

function rowToDto(r: JoinedRow): KpVersionDto {
  const k = r.kp;
  return {
    id: k.id,
    ticketId: k.ticketId,
    version: k.version,
    status: k.status,
    worksAmountKopecks: k.worksAmountKopecks.toString(),
    partsAmountKopecks: k.partsAmountKopecks.toString(),
    totalAmountKopecks: (k.worksAmountKopecks + k.partsAmountKopecks).toString(),
    description: k.description,
    sentAt: k.sentAt ?? null,
    respondedAt: k.respondedAt ?? null,
    rejectionReason: k.rejectionReason ?? null,
    createdByUserId: k.createdByUserId ?? null,
    createdByName: r.createdByName ?? null,
    createdAt: k.createdAt,
  };
}

const joinedSelect = {
  kp: ticketKpVersions,
  createdByName: users.fullName,
};

export async function listByTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<KpVersionDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(joinedSelect)
      .from(ticketKpVersions)
      .leftJoin(users, eq(users.id, ticketKpVersions.createdByUserId))
      .where(and(eq(ticketKpVersions.ticketId, ticketId), isNull(ticketKpVersions.deletedAt)))
      .orderBy(asc(ticketKpVersions.version));
    return rows.map(rowToDto);
  });
}

export async function getKpById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<KpVersionDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(joinedSelect)
      .from(ticketKpVersions)
      .leftJoin(users, eq(users.id, ticketKpVersions.createdByUserId))
      .where(and(eq(ticketKpVersions.id, id), isNull(ticketKpVersions.deletedAt)))
      .limit(1);
    return rows[0] ? rowToDto(rows[0]) : null;
  });
}

/** Создание с серверным назначением версии (MAX+1 в одной транзакции). */
export async function createKp(
  db: Db,
  tenantId: string,
  input: CreateKpInput,
): Promise<{ id: string; version: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const maxRows = await tx
      .select({ max: sql<number>`COALESCE(MAX(${ticketKpVersions.version}), 0)::int` })
      .from(ticketKpVersions)
      .where(
        and(eq(ticketKpVersions.ticketId, input.ticketId), isNull(ticketKpVersions.deletedAt)),
      );
    const version = (maxRows[0]?.max ?? 0) + 1;

    const inserted = await tx
      .insert(ticketKpVersions)
      .values({
        tenantId,
        ticketId: input.ticketId,
        version,
        status: input.status ?? 'draft',
        worksAmountKopecks: input.worksAmountKopecks,
        partsAmountKopecks: input.partsAmountKopecks,
        description: input.description,
        sentAt: input.status === 'sent' ? new Date() : null,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: ticketKpVersions.id });
    const row = inserted[0];
    if (!row) throw new Error('createKp: nothing returned');
    return { id: row.id, version };
  });
}

export async function updateKp(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateKpPatch,
): Promise<KpVersionDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (patch.status === 'sent') set.sentAt = sql`COALESCE(${ticketKpVersions.sentAt}, now())`;
      if (patch.status === 'rejected' || patch.status === 'revision') {
        set.respondedAt = sql`COALESCE(${ticketKpVersions.respondedAt}, now())`;
      }
    }
    if (patch.worksAmountKopecks !== undefined) set.worksAmountKopecks = patch.worksAmountKopecks;
    if (patch.partsAmountKopecks !== undefined) set.partsAmountKopecks = patch.partsAmountKopecks;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.rejectionReason !== undefined) set.rejectionReason = patch.rejectionReason;
    if (Object.keys(set).length === 0) {
      return getKpById(db, tenantId, id);
    }
    const updated = await tx
      .update(ticketKpVersions)
      .set(set)
      .where(and(eq(ticketKpVersions.id, id), isNull(ticketKpVersions.deletedAt)))
      .returning({ id: ticketKpVersions.id });
    if (!updated[0]) return null;
    return getKpById(db, tenantId, id);
  });
}

/**
 * Атомарный approve: версия → approved (+respondedAt), остальные approved-версии
 * той же заявки демотируются в rejected с пометкой (unique-approved семантика v1 Phase 96).
 * Возвращает null, если версия не найдена.
 */
export async function approveKp(
  db: Db,
  tenantId: string,
  id: string,
): Promise<KpVersionDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(ticketKpVersions)
      .where(and(eq(ticketKpVersions.id, id), isNull(ticketKpVersions.deletedAt)))
      .limit(1);
    const kp = rows[0];
    if (!kp) return null;

    await tx
      .update(ticketKpVersions)
      .set({ status: 'approved', respondedAt: kp.respondedAt ?? new Date() })
      .where(eq(ticketKpVersions.id, id));

    await tx
      .update(ticketKpVersions)
      .set({
        status: 'rejected',
        rejectionReason: `Заменена версией v${kp.version} (автоматически при утверждении)`,
      })
      .where(
        and(
          eq(ticketKpVersions.ticketId, kp.ticketId),
          ne(ticketKpVersions.id, kp.id),
          eq(ticketKpVersions.status, 'approved'),
          isNull(ticketKpVersions.deletedAt),
        ),
      );

    const after = await tx
      .select(joinedSelect)
      .from(ticketKpVersions)
      .leftJoin(users, eq(users.id, ticketKpVersions.createdByUserId))
      .where(eq(ticketKpVersions.id, id))
      .limit(1);
    return after[0] ? rowToDto(after[0]) : null;
  });
}

/** Soft-delete. Guard на approved — на уровне service. */
export async function archiveKp(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(ticketKpVersions)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(ticketKpVersions.id, id), isNull(ticketKpVersions.deletedAt)))
      .returning({ id: ticketKpVersions.id });
    return updated.length > 0;
  });
}

/** Последняя версия КП заявки (для шапки карточки). */
export async function latestByTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<KpVersionDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select(joinedSelect)
      .from(ticketKpVersions)
      .leftJoin(users, eq(users.id, ticketKpVersions.createdByUserId))
      .where(and(eq(ticketKpVersions.ticketId, ticketId), isNull(ticketKpVersions.deletedAt)))
      .orderBy(desc(ticketKpVersions.version))
      .limit(1);
    return rows[0] ? rowToDto(rows[0]) : null;
  });
}
