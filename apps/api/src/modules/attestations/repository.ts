/**
 * Stage 10'.I — Repository аттестаций инженеров.
 *
 * Все запросы — ТОЛЬКО через withTenantTx. RLS форсирована.
 *
 * Бизнес-правила:
 *   - SoftDelete через deleted_at (152-ФЗ, есть журнал изменений).
 *   - "Действующая аттестация" = deleted_at IS NULL AND (valid_until IS NULL OR valid_until >= today).
 *     Бессрочные допуски (valid_until IS NULL) считаются всегда активными — так
 *     заведено в большинстве учебных центров для постоянных сотрудников.
 *   - getActiveCategoriesForEngineer возвращает уникальный список категорий
 *     (для UI-бейджа диспетчера и для проверки в tickets/service.ts).
 */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  engineerAttestations,
  users,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type AttestationStatus = 'active' | 'expiring_soon' | 'expired';

export interface AttestationRow {
  id: string;
  engineerId: string;
  engineerFullName: string | null;
  category: string;
  issuedBy: string | null;
  certificateNumber: string | null;
  issuedAt: string;
  validUntil: string | null;
  documentAttachmentId: string | null;
  notes: string | null;
  status: AttestationStatus;
  createdAt: Date;
}

export interface AttestationInput {
  engineerId: string;
  category: string;
  issuedBy?: string | null;
  certificateNumber?: string | null;
  issuedAt: string; // YYYY-MM-DD
  validUntil?: string | null;
  documentAttachmentId?: string | null;
  notes?: string | null;
}

const SOON_DAYS = 30;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function computeStatus(validUntilIso: string | null): AttestationStatus {
  if (!validUntilIso) return 'active'; // бессрочно
  const today = todayIso();
  if (validUntilIso < today) return 'expired';
  if (daysBetween(today, validUntilIso) <= SOON_DAYS) return 'expiring_soon';
  return 'active';
}

export interface ListOpts {
  engineerId?: string;
  /** include или нет просроченные. По умолчанию — все. */
  includeExpired?: boolean;
}

export async function listAttestations(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<AttestationRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = [isNull(engineerAttestations.deletedAt)];
    if (opts.engineerId) filters.push(eq(engineerAttestations.engineerId, opts.engineerId));

    const rows = await tx
      .select({
        id: engineerAttestations.id,
        engineerId: engineerAttestations.engineerId,
        engineerFullName: users.fullName,
        category: engineerAttestations.category,
        issuedBy: engineerAttestations.issuedBy,
        certificateNumber: engineerAttestations.certificateNumber,
        issuedAt: engineerAttestations.issuedAt,
        validUntil: engineerAttestations.validUntil,
        documentAttachmentId: engineerAttestations.documentAttachmentId,
        notes: engineerAttestations.notes,
        createdAt: engineerAttestations.createdAt,
      })
      .from(engineerAttestations)
      .leftJoin(users, eq(engineerAttestations.engineerId, users.id))
      .where(and(...filters))
      .orderBy(asc(users.fullName), asc(engineerAttestations.category));

    return rows
      .map<AttestationRow>((r) => ({
        id: r.id,
        engineerId: r.engineerId,
        engineerFullName: r.engineerFullName,
        category: r.category,
        issuedBy: r.issuedBy,
        certificateNumber: r.certificateNumber,
        issuedAt: r.issuedAt,
        validUntil: r.validUntil,
        documentAttachmentId: r.documentAttachmentId,
        notes: r.notes,
        status: computeStatus(r.validUntil),
        createdAt: r.createdAt,
      }))
      .filter((r) => (opts.includeExpired === false ? r.status !== 'expired' : true));
  });
}

export async function getAttestationById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<AttestationRow | null> {
  const all = await listAttestations(db, tenantId);
  return all.find((r) => r.id === id) ?? null;
}

export class EngineerNotFoundError extends Error {
  constructor() {
    super('Инженер не найден в этом tenant');
  }
}

async function ensureEngineerExists(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  engineerId: string,
): Promise<void> {
  const found = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, engineerId), isNull(users.deletedAt)))
    .limit(1);
  if (!found[0]) throw new EngineerNotFoundError();
}

export async function createAttestation(
  db: Db,
  tenantId: string,
  input: AttestationInput,
): Promise<AttestationRow> {
  const created = await withTenantTx(db, tenantId, async (tx) => {
    await ensureEngineerExists(tx, input.engineerId);
    const inserted = await tx
      .insert(engineerAttestations)
      .values({
        tenantId,
        engineerId: input.engineerId,
        category: input.category.trim(),
        issuedBy: input.issuedBy?.trim() || null,
        certificateNumber: input.certificateNumber?.trim() || null,
        issuedAt: input.issuedAt,
        validUntil: input.validUntil ?? null,
        documentAttachmentId: input.documentAttachmentId ?? null,
        notes: input.notes?.trim() || null,
      })
      .returning({ id: engineerAttestations.id });
    return inserted[0]?.id ?? null;
  });
  if (!created) throw new Error('createAttestation: insert returned nothing');
  const row = await getAttestationById(db, tenantId, created);
  if (!row) throw new Error('createAttestation: row missing after insert');
  return row;
}

export interface UpdateInput {
  category?: string;
  issuedBy?: string | null;
  certificateNumber?: string | null;
  issuedAt?: string;
  validUntil?: string | null;
  documentAttachmentId?: string | null;
  notes?: string | null;
}

export async function updateAttestation(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateInput,
): Promise<AttestationRow | null> {
  await withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.category !== undefined) set.category = patch.category.trim();
    if (patch.issuedBy !== undefined) set.issuedBy = patch.issuedBy?.trim() || null;
    if (patch.certificateNumber !== undefined)
      set.certificateNumber = patch.certificateNumber?.trim() || null;
    if (patch.issuedAt !== undefined) set.issuedAt = patch.issuedAt;
    if (patch.validUntil !== undefined) set.validUntil = patch.validUntil;
    if (patch.documentAttachmentId !== undefined)
      set.documentAttachmentId = patch.documentAttachmentId;
    if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
    if (Object.keys(set).length === 0) return;
    await tx
      .update(engineerAttestations)
      .set(set)
      .where(
        and(eq(engineerAttestations.id, id), isNull(engineerAttestations.deletedAt)),
      );
  });
  return getAttestationById(db, tenantId, id);
}

export async function softDeleteAttestation(
  db: Db,
  tenantId: string,
  id: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(engineerAttestations)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(engineerAttestations.id, id), isNull(engineerAttestations.deletedAt)),
      )
      .returning({ id: engineerAttestations.id });
    return updated.length > 0;
  });
}

/**
 * Возвращает список категорий, по которым у инженера есть НЕ просроченная аттестация.
 * Используется UI диспетчера + проверкой в tickets/service.ts.
 */
export async function getActiveCategoriesForEngineer(
  db: Db,
  tenantId: string,
  engineerId: string,
): Promise<string[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const today = todayIso();
    const rows = await tx
      .select({ category: engineerAttestations.category })
      .from(engineerAttestations)
      .where(
        and(
          eq(engineerAttestations.engineerId, engineerId),
          isNull(engineerAttestations.deletedAt),
          or(
            isNull(engineerAttestations.validUntil),
            sql`${engineerAttestations.validUntil} >= ${today}`,
          ),
        ),
      );
    const set = new Set<string>();
    for (const r of rows) set.add(r.category);
    return Array.from(set);
  });
}

/**
 * Compliance-проверка для одного назначения. Возвращает текст предупреждения
 * (или null, если всё в порядке).
 *
 * Вызывается из tickets/service.ts при создании заявки или назначении инженера.
 */
export async function checkAttestationForAssignment(
  db: Db,
  tenantId: string,
  params: { engineerId: string; requiredCategory: string | null },
): Promise<string | null> {
  if (!params.requiredCategory) return null;
  const categories = await getActiveCategoriesForEngineer(db, tenantId, params.engineerId);
  if (categories.includes(params.requiredCategory)) return null;
  return `Инженер не имеет актуальной аттестации по категории «${params.requiredCategory}»`;
}
