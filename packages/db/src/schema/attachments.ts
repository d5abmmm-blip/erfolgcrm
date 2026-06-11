/**
 * Этап 6 — реестр вложений (фото, документы, скан-копии).
 *
 * Файлы лежат в Yandex Object Storage (bucket per-tenant), здесь — только метаданные.
 * uploaded_at = NULL означает pending presigned upload; confirmed после успешного PUT.
 *
 * Soft delete через deleted_at — фоновая чистка S3 идёт по этой колонке.
 */
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fkUuid, pk, tenantId } from './_shared';

export const attachmentKindEnum = pgEnum('attachment_kind', [
  'ticket_photo',
  'asset_photo',
  'inventory_receipt',
  'damage_photo',
  'completion_photo',
  'contract_signed',
  'document',
]);

export const attachmentReferenceTypeEnum = pgEnum('attachment_reference_type', [
  'ticket',
  'asset',
  'inventory_batch',
  'work_order_line',
  'contract',
]);

export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: attachmentKindEnum('kind').notNull(),
    referenceType: attachmentReferenceTypeEnum('reference_type').notNull(),
    referenceId: fkUuid('reference_id'),
    objectKey: varchar('object_key', { length: 500 }).notNull(),
    originalName: varchar('original_name', { length: 300 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // 0012: после soft-delete фоновый job чистит объект из S3 и проставляет purgedAt.
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (t) => [
    unique('attachments_object_key_uniq').on(t.objectKey),
    index('attachments_tenant_ref_idx').on(t.tenantId, t.referenceType, t.referenceId),
    index('attachments_tenant_kind_idx').on(t.tenantId, t.kind, t.createdAt),
    index('attachments_pending_idx').on(t.tenantId, t.createdAt),
    index('attachments_pending_purge_idx').on(t.deletedAt),
    check('attachments_size_nonneg', sql`${t.sizeBytes} >= 0`),
  ],
);
