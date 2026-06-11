/**
 * Stage 10'.J — Repository чек-листов приёма/выдачи.
 *
 * Все запросы — через withTenantTx (RLS).
 * Bulk insert checklist + items в одной транзакции (атомарно).
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  intakeChecklistItems,
  intakeChecklists,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export type ChecklistKind = 'intake' | 'handover';
export type ChecklistItemStatus = 'ok' | 'issue' | 'na';

export interface ChecklistItemInput {
  label: string;
  status: ChecklistItemStatus;
  comment?: string | null;
  photoAttachmentId?: string | null;
}

export interface CreateChecklistOpts {
  completedByUserId?: string | null;
  clientSignatureName?: string | null;
  notes?: string | null;
}

export interface ChecklistRow {
  id: string;
  ticketId: string;
  kind: ChecklistKind;
  completedAt: Date;
  completedByUserId: string | null;
  clientSignatureName: string | null;
  notes: string | null;
  itemsCount: number;
  issuesCount: number;
}

export interface ChecklistItemRow {
  id: string;
  checklistId: string;
  orderIdx: number;
  label: string;
  status: ChecklistItemStatus;
  comment: string | null;
  photoAttachmentId: string | null;
}

export interface ChecklistWithItems extends ChecklistRow {
  items: ChecklistItemRow[];
}

export async function createChecklistWithItems(
  db: Db,
  tenantId: string,
  ticketId: string,
  kind: ChecklistKind,
  items: ChecklistItemInput[],
  opts: CreateChecklistOpts = {},
): Promise<ChecklistWithItems> {
  if (items.length === 0) {
    throw new Error('Чек-лист должен содержать хотя бы один пункт');
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(intakeChecklists)
      .values({
        tenantId,
        ticketId,
        kind,
        completedByUserId: opts.completedByUserId ?? null,
        clientSignatureName: opts.clientSignatureName ?? null,
        notes: opts.notes ?? null,
      })
      .returning();
    const head = inserted[0];
    if (!head) throw new Error('createChecklistWithItems: insert returned nothing');

    const rowsToInsert = items.map((it, idx) => ({
      tenantId,
      checklistId: head.id,
      orderIdx: idx,
      label: it.label.slice(0, 300),
      status: it.status,
      comment: it.comment ?? null,
      photoAttachmentId: it.photoAttachmentId ?? null,
    }));

    const insertedItems = await tx
      .insert(intakeChecklistItems)
      .values(rowsToInsert)
      .returning();

    const issuesCount = insertedItems.filter((it) => it.status === 'issue').length;

    return {
      id: head.id,
      ticketId: head.ticketId,
      kind: head.kind,
      completedAt: head.completedAt,
      completedByUserId: head.completedByUserId,
      clientSignatureName: head.clientSignatureName,
      notes: head.notes,
      itemsCount: insertedItems.length,
      issuesCount,
      items: insertedItems
        .sort((a, b) => a.orderIdx - b.orderIdx)
        .map((it) => ({
          id: it.id,
          checklistId: it.checklistId,
          orderIdx: it.orderIdx,
          label: it.label,
          status: it.status as ChecklistItemStatus,
          comment: it.comment,
          photoAttachmentId: it.photoAttachmentId,
        })),
    };
  });
}

export async function getChecklistWithItems(
  db: Db,
  tenantId: string,
  checklistId: string,
): Promise<ChecklistWithItems | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const headRows = await tx
      .select()
      .from(intakeChecklists)
      .where(
        and(
          eq(intakeChecklists.id, checklistId),
          isNull(intakeChecklists.deletedAt),
        ),
      )
      .limit(1);
    const head = headRows[0];
    if (!head) return null;

    const items = await tx
      .select()
      .from(intakeChecklistItems)
      .where(eq(intakeChecklistItems.checklistId, checklistId))
      .orderBy(asc(intakeChecklistItems.orderIdx));

    const issuesCount = items.filter((it) => it.status === 'issue').length;

    return {
      id: head.id,
      ticketId: head.ticketId,
      kind: head.kind,
      completedAt: head.completedAt,
      completedByUserId: head.completedByUserId,
      clientSignatureName: head.clientSignatureName,
      notes: head.notes,
      itemsCount: items.length,
      issuesCount,
      items: items.map((it) => ({
        id: it.id,
        checklistId: it.checklistId,
        orderIdx: it.orderIdx,
        label: it.label,
        status: it.status as ChecklistItemStatus,
        comment: it.comment,
        photoAttachmentId: it.photoAttachmentId,
      })),
    };
  });
}

export async function listForTicket(
  db: Db,
  tenantId: string,
  ticketId: string,
): Promise<ChecklistRow[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const heads = await tx
      .select()
      .from(intakeChecklists)
      .where(
        and(
          eq(intakeChecklists.ticketId, ticketId),
          isNull(intakeChecklists.deletedAt),
        ),
      )
      .orderBy(desc(intakeChecklists.completedAt));
    if (heads.length === 0) return [];

    const items = await tx
      .select({
        checklistId: intakeChecklistItems.checklistId,
        status: intakeChecklistItems.status,
      })
      .from(intakeChecklistItems);

    const counts = new Map<string, { items: number; issues: number }>();
    for (const it of items) {
      const acc = counts.get(it.checklistId) ?? { items: 0, issues: 0 };
      acc.items += 1;
      if (it.status === 'issue') acc.issues += 1;
      counts.set(it.checklistId, acc);
    }

    return heads.map((h) => {
      const c = counts.get(h.id) ?? { items: 0, issues: 0 };
      return {
        id: h.id,
        ticketId: h.ticketId,
        kind: h.kind,
        completedAt: h.completedAt,
        completedByUserId: h.completedByUserId,
        clientSignatureName: h.clientSignatureName,
        notes: h.notes,
        itemsCount: c.items,
        issuesCount: c.issues,
      };
    });
  });
}

export async function softDelete(
  db: Db,
  tenantId: string,
  checklistId: string,
): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(intakeChecklists)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(intakeChecklists.id, checklistId),
          isNull(intakeChecklists.deletedAt),
        ),
      )
      .returning({ id: intakeChecklists.id });
    return updated.length > 0;
  });
}
