/**
 * Repository для attachments. Запросы под tenant'ом через withTenantTx (RLS).
 *
 * Жизненный цикл строки:
 *   insertPending → markUploaded → softDelete.
 *   uploaded_at NULL = ждём PUT в S3; не NULL = подтверждено;
 *   deleted_at NOT NULL = soft-удалено, S3-объект чистится фоновой задачей.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  assets,
  attachments,
  contracts,
  inventoryBatches,
  tickets,
  withTenantTx,
  workOrderLines,
  type Db,
} from '@erfolg/db';

export type AttachmentKind =
  | 'ticket_photo'
  | 'asset_photo'
  | 'inventory_receipt'
  | 'damage_photo'
  | 'completion_photo'
  | 'contract_signed'
  | 'document';

export type AttachmentReferenceType =
  | 'ticket'
  | 'asset'
  | 'inventory_batch'
  | 'work_order_line'
  | 'contract';

export interface AttachmentDto {
  id: string;
  kind: AttachmentKind;
  referenceType: AttachmentReferenceType;
  referenceId: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  uploadedByUserId: string | null;
  uploadedAt: Date | null;
  createdAt: Date;
}

function toDto(row: typeof attachments.$inferSelect): AttachmentDto {
  return {
    id: row.id,
    kind: row.kind,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    objectKey: row.objectKey,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes.toString(),
    uploadedByUserId: row.uploadedByUserId,
    uploadedAt: row.uploadedAt,
    createdAt: row.createdAt,
  };
}

export async function verifyReferenceBelongsToTenant(
  db: Db,
  tenantId: string,
  refType: AttachmentReferenceType,
  refId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    if (refType === 'ticket') {
      const r = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, refId)).limit(1);
      return r.length > 0;
    }
    if (refType === 'asset') {
      const r = await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, refId)).limit(1);
      return r.length > 0;
    }
    if (refType === 'inventory_batch') {
      const r = await tx
        .select({ id: inventoryBatches.id })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, refId))
        .limit(1);
      return r.length > 0;
    }
    if (refType === 'work_order_line') {
      const r = await tx
        .select({ id: workOrderLines.id })
        .from(workOrderLines)
        .where(eq(workOrderLines.id, refId))
        .limit(1);
      return r.length > 0;
    }
    if (refType === 'contract') {
      const r = await tx
        .select({ id: contracts.id })
        .from(contracts)
        .where(eq(contracts.id, refId))
        .limit(1);
      return r.length > 0;
    }
    return false;
  });
}

export interface InsertPendingInput {
  kind: AttachmentKind;
  referenceType: AttachmentReferenceType;
  referenceId: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: bigint;
  userId: string | null;
}

export async function insertPending(
  db: Db,
  tenantId: string,
  input: InsertPendingInput,
): Promise<AttachmentDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(attachments)
      .values({
        tenantId,
        kind: input.kind,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        objectKey: input.objectKey,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedByUserId: input.userId,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('insertPending: nothing returned');
    return toDto(row);
  });
}

export async function markUploaded(
  db: Db,
  tenantId: string,
  id: string,
): Promise<AttachmentDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(attachments)
      .set({ uploadedAt: sql`now()` })
      .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)))
      .returning();
    return updated[0] ? toDto(updated[0]) : null;
  });
}

export async function listByReference(
  db: Db,
  tenantId: string,
  refType: AttachmentReferenceType,
  refId: string,
): Promise<AttachmentDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.referenceType, refType),
          eq(attachments.referenceId, refId),
          isNull(attachments.deletedAt),
        ),
      )
      .orderBy(attachments.createdAt);
    return rows.map(toDto);
  });
}

export async function getById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<AttachmentDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)))
      .limit(1);
    return rows[0] ? toDto(rows[0]) : null;
  });
}

export async function softDelete(
  db: Db,
  tenantId: string,
  id: string,
): Promise<{ objectKey: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(attachments)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)))
      .returning({ objectKey: attachments.objectKey });
    return updated[0] ?? null;
  });
}
