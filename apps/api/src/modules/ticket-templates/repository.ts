/**
 * Repository для ticket_templates.
 *
 * lines храним как jsonb — отдельной таблицы нет, см. schema/ticket-templates.ts.
 *
 * Все запросы — через withTenantTx, чтобы RLS отрабатывал (видим только свой tenant).
 * Уникальность имени активного шаблона обеспечивается partial UNIQUE INDEX в БД
 * (см. миграцию 0029_ticket_templates.sql); при конфликте кидаем
 * TicketTemplateNameConflictError, который сервис маппит в TRPC CONFLICT.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ticketTemplates, withTenantTx, type Db, type TicketTemplateLine } from '@erfolg/db';
import {
  TicketTemplateArchivedError,
  TicketTemplateNameConflictError,
  TicketTemplateNotFoundError,
} from '../../lib/errors';
import { pgErrorCode, pgErrorText } from '../../lib/pg-error';
import type { RepairType, TicketPriority } from '@erfolg/shared';

const NAME_UNIQUE_INDEX = 'ticket_templates_tenant_name_active_uniq';

export interface TicketTemplateDto {
  id: string;
  name: string;
  description: string | null;
  defaultRepairType: RepairType | null;
  defaultPriority: TicketPriority | null;
  defaultEstimatedMinutes: number | null;
  lines: TicketTemplateLine[];
  archivedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Удобство для UI — кратко: число строк по типам. */
  linesCount: number;
}

export interface CreateTemplateInput {
  name: string;
  description: string | null;
  defaultRepairType: RepairType | null;
  defaultPriority: TicketPriority | null;
  defaultEstimatedMinutes: number | null;
  lines: TicketTemplateLine[];
  createdByUserId: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  defaultRepairType?: RepairType | null;
  defaultPriority?: TicketPriority | null;
  defaultEstimatedMinutes?: number | null;
  lines?: TicketTemplateLine[];
}

function toDto(row: typeof ticketTemplates.$inferSelect): TicketTemplateDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultRepairType: row.defaultRepairType,
    defaultPriority: row.defaultPriority,
    defaultEstimatedMinutes: row.defaultEstimatedMinutes,
    lines: row.lines,
    archivedAt: row.archivedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    linesCount: row.lines.length,
  };
}

/** Маппит unique-violation от частичного индекса в доменную ошибку. */
function rethrowUnique(err: unknown, name: string): never {
  // Код 23505 и имя индекса достаём через pg-error helpers — drizzle ≥0.44
  // оборачивает ошибку драйвера, оригинал лежит в .cause.
  if (pgErrorCode(err) === '23505' || pgErrorText(err).includes(NAME_UNIQUE_INDEX)) {
    throw new TicketTemplateNameConflictError(name);
  }
  throw err;
}

export async function listTemplates(
  db: Db,
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<TicketTemplateDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = opts.includeArchived ? undefined : isNull(ticketTemplates.archivedAt);
    const rows = await tx
      .select()
      .from(ticketTemplates)
      .where(filters)
      .orderBy(asc(ticketTemplates.name));
    return rows.map(toDto);
  });
}

export async function getTemplate(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TicketTemplateDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.select().from(ticketTemplates).where(eq(ticketTemplates.id, id)).limit(1);
    return rows[0] ? toDto(rows[0]) : null;
  });
}

export async function createTemplate(
  db: Db,
  tenantId: string,
  input: CreateTemplateInput,
): Promise<TicketTemplateDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    try {
      const inserted = await tx
        .insert(ticketTemplates)
        .values({
          tenantId,
          name: input.name,
          description: input.description,
          defaultRepairType: input.defaultRepairType,
          defaultPriority: input.defaultPriority,
          defaultEstimatedMinutes: input.defaultEstimatedMinutes,
          lines: input.lines,
          createdByUserId: input.createdByUserId,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('createTemplate: insert returned nothing');
      return toDto(row);
    } catch (err) {
      rethrowUnique(err, input.name);
    }
  });
}

export async function updateTemplate(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateTemplateInput,
): Promise<TicketTemplateDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const setObj: Record<string, unknown> = {};
    if (patch.name !== undefined) setObj.name = patch.name;
    if (patch.description !== undefined) setObj.description = patch.description;
    if (patch.defaultRepairType !== undefined) setObj.defaultRepairType = patch.defaultRepairType;
    if (patch.defaultPriority !== undefined) setObj.defaultPriority = patch.defaultPriority;
    if (patch.defaultEstimatedMinutes !== undefined)
      setObj.defaultEstimatedMinutes = patch.defaultEstimatedMinutes;
    if (patch.lines !== undefined) setObj.lines = patch.lines;
    if (Object.keys(setObj).length === 0) {
      const existing = await tx
        .select()
        .from(ticketTemplates)
        .where(eq(ticketTemplates.id, id))
        .limit(1);
      if (!existing[0]) throw new TicketTemplateNotFoundError();
      return toDto(existing[0]);
    }
    setObj.updatedAt = new Date();
    try {
      const updated = await tx
        .update(ticketTemplates)
        .set(setObj)
        .where(eq(ticketTemplates.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new TicketTemplateNotFoundError();
      return toDto(row);
    } catch (err) {
      if (patch.name !== undefined) rethrowUnique(err, patch.name);
      throw err;
    }
  });
}

export async function archiveTemplate(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TicketTemplateDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(ticketTemplates)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(ticketTemplates.id, id), isNull(ticketTemplates.archivedAt)))
      .returning();
    const row = updated[0];
    if (!row) {
      // Проверим причину — 0 rows может быть из-за «уже архивирован» или «не найден».
      const existing = await tx
        .select()
        .from(ticketTemplates)
        .where(eq(ticketTemplates.id, id))
        .limit(1);
      if (!existing[0]) throw new TicketTemplateNotFoundError();
      return toDto(existing[0]);
    }
    return toDto(row);
  });
}

export async function unarchiveTemplate(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TicketTemplateDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const existing = await tx
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.id, id))
      .limit(1);
    if (!existing[0]) throw new TicketTemplateNotFoundError();
    if (existing[0].archivedAt === null) return toDto(existing[0]);
    try {
      const updated = await tx
        .update(ticketTemplates)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(ticketTemplates.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new TicketTemplateNotFoundError();
      return toDto(row);
    } catch (err) {
      rethrowUnique(err, existing[0].name);
    }
  });
}

/**
 * Возвращает шаблон, гарантируя что он не архивирован.
 * Используется в apply: к новой заявке нельзя применить архивный шаблон.
 */
export async function getActiveTemplateOrThrow(
  db: Db,
  tenantId: string,
  id: string,
): Promise<TicketTemplateDto> {
  const tpl = await getTemplate(db, tenantId, id);
  if (!tpl) throw new TicketTemplateNotFoundError();
  if (tpl.archivedAt) throw new TicketTemplateArchivedError();
  return tpl;
}

/** Утилита для тестов: посчитать число активных шаблонов в tenant'е. */
export async function countActive(db: Db, tenantId: string): Promise<number> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(ticketTemplates)
      .where(isNull(ticketTemplates.archivedAt));
    return rows[0]?.c ?? 0;
  });
}
