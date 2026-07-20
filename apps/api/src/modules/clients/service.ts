/**
 * Service слой clients/contacts.
 *
 * Оборачивает repository, дёргает writeAudit на каждое изменение.
 *
 * ВАЖНО: в audit before/after НЕ кладём decrypted PII (ФИО, телефон, адрес физлиц).
 * Логируем только маркеры «*_changed» — auditLogs тоже чувствителен.
 */
import { TRPCError } from '@trpc/server';
import { type Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import {
  archiveClient as repoArchiveClient,
  unarchiveClient as repoUnarchiveClient,
  createClient as repoCreateClient,
  createContact as repoCreateContact,
  deleteContact as repoDeleteContact,
  getClient as repoGetClient,
  listClients as repoListClients,
  searchClients as repoSearchClients,
  updateClient as repoUpdateClient,
  updateContact as repoUpdateContact,
  type ClientDetailDto,
  type CreateClientInput,
  type CreateContactInput,
  type UpdateClientInput,
  type UpdateContactInput,
} from './repository';
import type { ResolvedTenant } from '../../lib/tenant';
import type { SessionData } from '../../lib/session';

interface AuditCtx {
  ip?: string | null;
  userAgent?: string | null;
}

/** Список PII-полей, для которых в audit пишем только сам факт изменения, без значений. */
const PII_FIELDS = new Set([
  'individualFullName',
  'individualPhone',
  'individualAddress',
]);

function sanitizeForAudit(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = PII_FIELDS.has(k) ? '[PII_REDACTED]' : v;
  }
  return out;
}

export async function createClientCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  input: CreateClientInput,
): Promise<{ id: string }> {
  // Базовая валидация: subtype только для legal
  if (input.subtype && input.type !== 'legal') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'subtype может быть задан только для юридического лица',
    });
  }
  if (input.type === 'individual' && !input.individualFullName) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Для физлица обязательно ФИО',
    });
  }
  const result = await repoCreateClient(db, tenant.id, input);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'create',
    entityType: 'client',
    entityId: result.id,
    after: sanitizeForAudit({
      type: input.type,
      subtype: input.subtype,
      displayName: input.displayName,
      inn: input.inn,
      individualFullName: input.individualFullName,
      individualPhone: input.individualPhone,
    }),
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
  return result;
}

export async function updateClientCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  patch: UpdateClientInput,
): Promise<void> {
  const before = await repoGetClient(db, tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Клиент не найден' });
  const { updatedFields } = await repoUpdateClient(db, tenant.id, id, patch);
  if (updatedFields.length === 0) return;
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'update',
    entityType: 'client',
    entityId: id,
    before: sanitizeForAudit({ updatedFields }),
    after: sanitizeForAudit({ ...patch }),
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function archiveClientCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  reason?: string,
): Promise<void> {
  const before = await repoGetClient(db, tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Клиент не найден' });
  await repoArchiveClient(db, tenant.id, id);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'delete',
    entityType: 'client',
    entityId: id,
    context: reason ? { reason } : null,
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function unarchiveClientCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
): Promise<void> {
  const before = await repoGetClient(db, tenant.id, id);
  if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Клиент не найден' });
  // Идемпотентно: повторный возврат уже активного клиента не ошибка, а «ничего
  // делать не надо». Так безопаснее для двойного клика по кнопке.
  if (before.status === 'active') return;
  await repoUnarchiveClient(db, tenant.id, id);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'restore',
    entityType: 'client',
    entityId: id,
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function listClientsQuery(
  db: Db,
  tenant: ResolvedTenant,
  opts: { search?: string; status?: 'active' | 'archived'; page?: number },
) {
  return repoListClients(db, tenant.id, opts);
}

export async function getClientQuery(
  db: Db,
  tenant: ResolvedTenant,
  id: string,
): Promise<ClientDetailDto> {
  const c = await repoGetClient(db, tenant.id, id);
  if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Клиент не найден' });
  return c;
}

export async function searchClientsQuery(
  db: Db,
  tenant: ResolvedTenant,
  q: string,
) {
  return repoSearchClients(db, tenant.id, q);
}

export async function addContactCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  input: CreateContactInput,
): Promise<{ id: string }> {
  // Проверяем что клиент существует и принадлежит tenant'у (RLS уже отсекает чужих,
  // но даём явный 404).
  const owner = await repoGetClient(db, tenant.id, input.clientId);
  if (!owner) throw new TRPCError({ code: 'NOT_FOUND', message: 'Клиент не найден' });
  const result = await repoCreateContact(db, tenant.id, input);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'create',
    entityType: 'contact',
    entityId: result.id,
    after: sanitizeForAudit({
      clientId: input.clientId,
      position: input.position,
      isPrimary: input.isPrimary,
    }),
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
  return result;
}

export async function updateContactCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
  patch: UpdateContactInput,
): Promise<void> {
  await repoUpdateContact(db, tenant.id, id, patch);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'update',
    entityType: 'contact',
    entityId: id,
    after: sanitizeForAudit({
      position: patch.position,
      isPrimary: patch.isPrimary,
      hadFullNameChange: patch.fullName !== undefined,
      hadPhoneChange: patch.phone !== undefined,
    }),
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}

export async function deleteContactCmd(
  db: Db,
  tenant: ResolvedTenant,
  session: SessionData,
  audit: AuditCtx,
  id: string,
): Promise<void> {
  await repoDeleteContact(db, tenant.id, id);
  await writeAudit(db, tenant.id, {
    userId: session.userId,
    action: 'delete',
    entityType: 'contact',
    entityId: id,
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
  });
}
