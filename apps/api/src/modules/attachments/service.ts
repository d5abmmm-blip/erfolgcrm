/**
 * Service-слой attachments — двухшаговый upload через presigned URLs.
 *
 * Flow:
 *   1. createUploadUrlCmd → row pending + presigned PUT URL.
 *   2. Клиент PUT-ит файл напрямую в S3 (или local emulator).
 *   3. confirmUploadCmd → проверяет storage.head() → markUploaded.
 *   4. listByReferenceQuery → DTO + presigned GET URL для каждого.
 *   5. deleteCmd → soft delete + remove из storage.
 */
import { TRPCError } from '@trpc/server';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { buildObjectKey, getObjectStorage } from '../../lib/object-storage';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { enqueueAttachmentPurge } from '../../workers/storage-cleanup';
import { logger } from '../../lib/logger';
import {
  getById as repoGetById,
  insertPending,
  listByReference as repoList,
  markUploaded,
  softDelete,
  verifyReferenceBelongsToTenant,
  type AttachmentDto,
  type AttachmentKind,
  type AttachmentReferenceType,
} from './repository';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

export interface CreateUploadUrlInput {
  kind: AttachmentKind;
  referenceType: AttachmentReferenceType;
  referenceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface CreateUploadUrlResult {
  attachmentId: string;
  objectKey: string;
  presignedUrl: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export async function createUploadUrlCmd(
  ctx: CmdCtx,
  input: CreateUploadUrlInput,
): Promise<CreateUploadUrlResult> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Тип файла не поддерживается' });
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_SIZE_BYTES) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Размер файла вне допустимого диапазона' });
  }
  const ok = await verifyReferenceBelongsToTenant(
    ctx.db,
    ctx.tenant.id,
    input.referenceType,
    input.referenceId,
  );
  if (!ok) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Объект для прикрепления не найден' });
  }
  const objectKey = buildObjectKey({
    tenantId: ctx.tenant.id,
    kind: input.kind,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    fileName: input.fileName,
  });
  const dto = await insertPending(ctx.db, ctx.tenant.id, {
    kind: input.kind,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    objectKey,
    originalName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: BigInt(input.sizeBytes),
    userId: ctx.session.userId,
  });
  const presigned = await getObjectStorage().presignPut({
    key: objectKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  });
  return {
    attachmentId: dto.id,
    objectKey,
    presignedUrl: presigned.url,
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
  };
}

export interface ConfirmUploadResult extends AttachmentDto {
  presignedGetUrl: string;
  getUrlExpiresAt: Date;
}

async function presignDto(dto: AttachmentDto): Promise<ConfirmUploadResult> {
  const get = await getObjectStorage().presignGet(dto.objectKey);
  return { ...dto, presignedGetUrl: get.url, getUrlExpiresAt: get.expiresAt };
}

export async function confirmUploadCmd(
  ctx: CmdCtx,
  attachmentId: string,
): Promise<ConfirmUploadResult> {
  const existing = await repoGetById(ctx.db, ctx.tenant.id, attachmentId);
  if (!existing) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Вложение не найдено' });
  }
  const head = await getObjectStorage().head(existing.objectKey);
  if (!head) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Файл не загружен в хранилище' });
  }
  const updated = await markUploaded(ctx.db, ctx.tenant.id, attachmentId);
  if (!updated) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Вложение исчезло' });
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'attachment',
    entityId: attachmentId,
    after: {
      kind: updated.kind,
      referenceType: updated.referenceType,
      referenceId: updated.referenceId,
      sizeBytes: updated.sizeBytes,
      mimeType: updated.mimeType,
    },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return presignDto(updated);
}

export async function listByReferenceQuery(
  db: Db,
  tenant: ResolvedTenant,
  refType: AttachmentReferenceType,
  refId: string,
): Promise<ConfirmUploadResult[]> {
  const rows = await repoList(db, tenant.id, refType, refId);
  const onlyUploaded = rows.filter((r) => r.uploadedAt !== null);
  return Promise.all(onlyUploaded.map(presignDto));
}

export async function deleteCmd(ctx: CmdCtx, id: string): Promise<{ ok: true }> {
  const result = await softDelete(ctx.db, ctx.tenant.id, id);
  if (!result) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Вложение не найдено' });
  }
  // Soft-delete отметку поставили; реальное удаление S3-объекта — фоновым job'ом
  // через STORAGE_PURGE_DELAY_HOURS (24h по умолчанию). Это даёт grace-период на восстановление.
  await enqueueAttachmentPurge({
    tenantId: ctx.tenant.id,
    attachmentId: id,
    objectKey: result.objectKey,
  }).catch((err: unknown) => {
    // Если очередь недоступна — fallback на синхронное удаление, чтобы не оставить мусор в S3.
    logger.warn({ err, attachmentId: id }, 'enqueue purge failed; falling back to sync remove');
    return getObjectStorage().remove(result.objectKey).catch(() => undefined);
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'delete',
    entityType: 'attachment',
    entityId: id,
    after: { objectKey: result.objectKey },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ok: true };
}
